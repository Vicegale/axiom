import type {
  Axiom,
  StewardBlindSpot,
  StewardSettings,
  StewardWake,
  StewardWakeTrigger,
} from "@axiom/core";
import type { ChangeBus } from "../events.js";
import { runChecklist } from "./checklist.js";
import {
  ConnectorProbe,
  type ConnectorSource,
  classifyConnectors,
  type SourceAvailability,
} from "./connectors.js";
import { applyDecision, buildDecideInput, runDecide } from "./decide.js";
import { buildGatherInput, runGather } from "./gather.js";
import { PrPoller } from "./pr.js";
import { StageError } from "./runner.js";
import { runTidy } from "./tidy.js";

/**
 * Steward's scheduler (03, Decisions "Wakes"): a timer wake every `wakeIntervalMin` inside working
 * hours, event wakes (a thread stops on a topic in `monitoring` or `review`; the PR poller sees a
 * new signal) at any hour, one wake at a time. Nothing here spends tokens unless Steward is on.
 */

const actor = { kind: "steward" } as const;
const DAY_MS = 86_400_000;
const DEFAULT_TICK_MS = 30_000;
const EVENT_STATUSES = new Set(["monitoring", "review"]);

export interface StewardOptions {
  ax: Axiom;
  bus?: ChangeBus;
  /** The `claude` binary when the `claudeCli` setting is not set. */
  claudeCli: string;
  /** The `gh` binary. */
  ghCli: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** How often the scheduler looks at the clock (default 30 s); 0 starts no timer (tests call `tick`). */
  tickMs?: number;
  /** A heartbeat gap longer than this means Steward was off (default five ticks, at least 2 min). */
  heartbeatGapMs?: number;
  /** Replaces the connector probe (tests). */
  connectors?: ConnectorProbe;
  connectorTtlMs?: number;
}

/** Whether `date` (local time) falls inside the working hours. */
export function inWorkingHours(hours: StewardSettings["workingHours"], date: Date): boolean {
  const iso = date.getDay() === 0 ? 7 : date.getDay();
  if (!hours.days.includes(iso)) return false;
  const mins = date.getHours() * 60 + date.getMinutes();
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const [start, end] = [toMin(hours.start), toMin(hours.end)];
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

const RANK: Record<StewardWakeTrigger, number> = { timer: 0, event: 1, "tidy-up": 1, owner: 2 };

interface WakeRequest {
  trigger: StewardWakeTrigger;
  details: string[];
  topic?: string;
  resolve: (w: StewardWake | null) => void;
  promise: Promise<StewardWake | null>;
}

function newRequest(
  trigger: StewardWakeTrigger,
  detail: string | undefined,
  topic?: string,
): WakeRequest {
  let resolve!: (w: StewardWake | null) => void;
  const promise = new Promise<StewardWake | null>((r) => {
    resolve = r;
  });
  return { trigger, details: detail ? [detail] : [], topic, resolve, promise };
}

export class Steward {
  readonly poller: PrPoller;
  readonly connectors: ConnectorProbe;
  private idle: Promise<void> = Promise.resolve();
  private running = false;
  private pending: WakeRequest | null = null;
  private stopped = false;
  private ticking = false;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopCursor: number;
  private enabledSince: string | null = null;

  constructor(private readonly o: StewardOptions) {
    this.poller = new PrPoller({ ax: o.ax, gh: o.ghCli, now: o.now, env: o.env });
    this.connectors =
      o.connectors ??
      new ConnectorProbe({
        cli: () => this.cli(),
        env: o.env,
        now: o.now ? () => (o.now as () => Date)().getTime() : undefined,
        ttlMs: o.connectorTtlMs,
      });
    this.stopCursor = o.ax.lastEntryId();
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private settings(): StewardSettings {
    return this.o.ax.getStewardSettings();
  }

  private cli(): string {
    const s = this.o.ax.getSetting("claudeCli");
    return typeof s === "string" && s ? s : this.o.claudeCli;
  }

  /** Resolves when no wake is running and none is waiting (for tests and shutdown). */
  async settle(): Promise<void> {
    while (this.running) await this.idle;
  }

  start(): void {
    const tickMs = this.o.tickMs ?? DEFAULT_TICK_MS;
    this.unsubscribe = this.o.bus?.subscribe(() => this.scanStops());
    if (tickMs > 0) {
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.timer.unref();
      void this.tick();
    }
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    clearInterval(this.timer);
  }

  // ---- the clock -----------------------------------------------------------

  /**
   * One look at the clock: note that Steward is on, scan for thread stops, poll `gh` when due
   * (working hours), start a timer wake when due (working hours). Never throws.
   */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const s = this.settings();
      if (!s.enabled) {
        if (this.enabledSince !== null) this.o.ax.clearStewardHeartbeat();
        this.enabledSince = null;
        this.stopCursor = this.o.ax.lastEntryId(); // stops while off are not replayed
        return;
      }
      const gap =
        this.o.heartbeatGapMs ?? Math.max(5 * (this.o.tickMs ?? DEFAULT_TICK_MS), 120_000);
      this.enabledSince = this.o.ax.stewardHeartbeat(gap);
      this.scanStops();
      const inHours = inWorkingHours(s.workingHours, this.now());
      if (inHours && s.sources.github && this.poller.due(s.ghPollIntervalMin)) {
        const r = await this.poller.poll();
        if (r.signals.length > 0) {
          void this.requestWake(
            "event",
            r.signals.map((x) => `${x.topic}: PR ${x.repo}#${x.number}: ${x.detail}`).join("; "),
          );
        }
      }
      if (inHours && this.timerWakeDue(s)) void this.requestWake("timer", undefined);
    } catch (e) {
      console.error("steward tick failed:", e);
    } finally {
      this.ticking = false;
    }
  }

  private timerWakeDue(s: StewardSettings): boolean {
    if (this.running || this.pending) return false;
    const last = this.o.ax.listStewardWakes(1)[0];
    return !last || this.now().getTime() - Date.parse(last.startedAt) >= s.wakeIntervalMin * 60_000;
  }

  /**
   * A thread stopped on a topic in `monitoring` or `review` (hooks and the T3 sync both write a
   * `thread event` entry with event `stopped`; the topic's status is read after the stop).
   */
  scanStops(): void {
    if (this.stopped) return;
    try {
      const stops = this.o.ax.listThreadStopsSince(this.stopCursor);
      if (stops.length === 0) return;
      this.stopCursor = Math.max(...stops.map((x) => x.entryId));
      if (!this.settings().enabled) return;
      const slugs = [
        ...new Set(
          stops
            .filter(
              (x) =>
                x.stewardEnabled && x.topicStatus !== null && EVENT_STATUSES.has(x.topicStatus),
            )
            .map((x) => `${x.topicSlug} (${x.topicStatus})`),
        ),
      ];
      if (slugs.length > 0)
        void this.requestWake("event", `a thread stopped on ${slugs.join(", ")}`);
    } catch (e) {
      console.error("steward stop scan failed:", e);
    }
  }

  // ---- wakes ---------------------------------------------------------------

  /**
   * Asks for a wake. Resolves with the wake once it is over, or with null when nothing ran
   * (Steward is off or stopped). A request made while a wake runs is coalesced with other waiting
   * requests into one follow-up wake. Event and owner wakes ignore working hours; the timer
   * checks them itself. `opts.topic` restricts the wake to one topic (an owner wake from the chat).
   */
  requestWake(
    trigger: StewardWakeTrigger,
    detail: string | undefined,
    opts: { topic?: string } = {},
  ): Promise<StewardWake | null> {
    if (this.stopped || !this.settings().enabled) return Promise.resolve(null);
    if (this.running) {
      const p = this.pending;
      if (!p) {
        this.pending = newRequest(trigger, detail, opts.topic);
      } else {
        if (RANK[trigger] > RANK[p.trigger]) p.trigger = trigger;
        if (detail) p.details.push(detail);
        if (p.topic !== opts.topic) p.topic = undefined;
      }
      return (this.pending as WakeRequest).promise;
    }
    const req = newRequest(trigger, detail, opts.topic);
    this.launch(req);
    return req.promise;
  }

  private launch(req: WakeRequest): void {
    this.running = true;
    this.idle = this.execute(req)
      .then(
        (w) => req.resolve(w),
        (e) => {
          console.error("steward wake failed:", e);
          req.resolve(null);
        },
      )
      .finally(() => {
        this.running = false;
        const next = this.pending;
        this.pending = null;
        if (next && !this.stopped && this.settings().enabled) this.launch(next);
        else next?.resolve(null);
      });
  }

  /** Where this wake reads changes from: the last finished wake's start, else 24 hours back. */
  private lookBack(now: Date): Date {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const last = this.o.ax.listStewardWakes(20).find((w) => w.status === "done");
    // No wake yet, or Steward was off since the last one: the previous wake says nothing.
    if (!last || this.enabledSince === null || last.startedAt < this.enabledSince) return dayAgo;
    return new Date(last.startedAt);
  }

  private async sources(s: StewardSettings): Promise<Record<ConnectorSource, SourceAvailability>> {
    const none = (reason: string): SourceAvailability => ({
      available: false,
      reason,
      tools: [],
      servers: [],
    });
    const wanted = (["slack", "googleDrive"] as const).filter((k) => s.sources[k]);
    if (wanted.length === 0) {
      return { slack: none("off in settings"), googleDrive: none("off in settings") };
    }
    const c = classifyConnectors(await this.connectors.get());
    return {
      slack: s.sources.slack ? c.slack : none("off in settings"),
      googleDrive: s.sources.googleDrive ? c.googleDrive : none("off in settings"),
    };
  }

  private async execute(req: WakeRequest): Promise<StewardWake> {
    const { ax } = this.o;
    const now = this.now();
    const s = this.settings();
    const lookBackFrom = this.lookBack(now);
    const trigger = req.trigger;
    const triggerDetail = [...new Set(req.details)].join("; ") || undefined;
    const wake = ax.startStewardWake(
      { trigger, triggerDetail, lookBackFrom: lookBackFrom.toISOString() },
      actor,
    );
    this.o.bus?.emit();
    const end = (
      status: "done" | "failed" | "cut short",
      error?: string,
      brief?: string,
    ): StewardWake => {
      const w = ax.finishStewardWake(wake.id, { status, error, brief }, actor);
      this.o.bus?.emit();
      return w;
    };
    try {
      let spots: StewardBlindSpot[] = [];
      let sources: Record<ConnectorSource, SourceAvailability> = {
        slack: { available: false, tools: [], servers: [] },
        googleDrive: { available: false, tools: [], servers: [] },
      };
      try {
        sources = await this.sources(s);
        const c = await runChecklist({
          ax,
          gh: this.o.ghCli,
          env: this.o.env,
          connectors: sources,
          prErrors: this.poller.lastErrors,
        });
        spots = c.spots;
      } catch (e) {
        spots = [{ kind: "checklist failed", text: e instanceof Error ? e.message : String(e) }];
      }
      ax.setStewardWakeBlindSpots(wake.id, spots, actor);

      const input = buildGatherInput(ax, {
        since: lookBackFrom,
        until: now,
        trigger,
        triggerDetail: triggerDetail ?? null,
        topic: req.topic,
        sources,
        blindSpots: spots,
      });
      const ctx = { ax, cli: this.cli(), env: this.o.env };
      // Stage 1. If it fails the wake ends here: stage 2 has nothing to read.
      await runGather({ ctx, wake, input });

      // Mechanical tidying in code, then stage 2 decides on what is left.
      const tidied = runTidy(ax, { wakeId: wake.id, now, topic: req.topic });
      const gathered = ax.getStewardWake(wake.id);
      const reply = await runDecide({
        ctx,
        wake: gathered,
        input: buildDecideInput(ax, { wake: gathered, now, tidied, topic: req.topic }),
      });
      const applied = applyDecision(ax, gathered, reply, spots);
      return end(
        "done",
        applied.problems.length
          ? `${applied.problems.length} result(s) could not be applied: ${applied.problems.join("; ")}`
          : undefined,
        reply.brief,
      );
    } catch (e) {
      if (e instanceof StageError)
        return end(e.code === "cap" || e.code === "timeout" ? "cut short" : "failed", e.message);
      return end("failed", e instanceof Error ? e.message : String(e));
    }
  }
}
