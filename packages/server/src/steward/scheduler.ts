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
import { runFreshen } from "./freshen.js";
import { buildGatherInput, runGather } from "./gather.js";
import { estimateTokens, runTidyUpStage, type TidyResult } from "./memory.js";
import { PrPoller } from "./pr.js";
import { runPromotion } from "./promote.js";
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

/**
 * The first moment at or after `from` that falls inside the working hours (local time), or null
 * when the hours name no day.
 */
export function nextWorkingTime(hours: StewardSettings["workingHours"], from: Date): Date | null {
  if (inWorkingHours(hours, from)) return from;
  const [h, m] = [Number(hours.start.slice(0, 2)), Number(hours.start.slice(3))];
  for (let d = 0; d <= 8; d++) {
    const t = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d, h, m);
    if (t.getTime() > from.getTime() && inWorkingHours(hours, t)) return t;
  }
  return null;
}

const RANK: Record<StewardWakeTrigger, number> = { timer: 0, event: 1, "tidy-up": 1, owner: 2 };

interface WakeRequest {
  trigger: StewardWakeTrigger;
  details: string[];
  topic?: string;
  /** The owner asked for it directly (Run now): runs even while Steward is off. */
  force?: boolean;
  resolve: (w: StewardWake | null) => void;
  promise: Promise<StewardWake | null>;
}

function newRequest(
  trigger: StewardWakeTrigger,
  detail: string | undefined,
  topic?: string,
  force?: boolean,
): WakeRequest {
  let resolve!: (w: StewardWake | null) => void;
  const promise = new Promise<StewardWake | null>((r) => {
    resolve = r;
  });
  return { trigger, details: detail ? [detail] : [], topic, force, resolve, promise };
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

  /**
   * When the next timer wake is due (ISO), or null when Steward is off or no working day is set.
   * It is the last wake's start plus the interval, moved into the working hours; a time already
   * past means "at the next look at the clock" and is returned as now.
   */
  nextWakeAt(): string | null {
    const s = this.settings();
    if (!s.enabled) return null;
    const now = this.now();
    const last = this.lastRegularWake();
    const due = last ? new Date(Date.parse(last.startedAt) + s.wakeIntervalMin * 60_000) : now;
    const next = nextWorkingTime(s.workingHours, due.getTime() > now.getTime() ? due : now);
    return next ? next.toISOString() : null;
  }

  /** Resolves when no wake is running and none is waiting (for tests and shutdown). */
  async settle(): Promise<void> {
    while (this.running) await this.idle;
  }

  start(): void {
    const tickMs = this.o.tickMs ?? DEFAULT_TICK_MS;
    this.unsubscribe = this.o.bus?.subscribe(() => {
      this.scanStops();
      this.pickUpRequests();
    });
    if (tickMs > 0) {
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.timer.unref();
      void this.tick();
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.o.ax.clearStewardServerBeat();
    } catch {
      // the database may already be closed
    }
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
      this.beat();
      this.pickUpRequests();
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

  /** Tells the CLI a server is running (and when the next timer wake is due). */
  private beat(): void {
    try {
      const tickMs = this.o.tickMs ?? DEFAULT_TICK_MS;
      this.o.ax.setStewardServerBeat(
        { pid: process.pid, freshMs: Math.max(3 * tickMs, 90_000), nextWakeAt: this.nextWakeAt() },
        actor,
      );
    } catch (e) {
      console.error("steward beat failed:", e);
    }
  }

  /**
   * Requests the CLI wrote (`axiom steward check|run`): each is marked handled first, then
   * becomes a wake request (`run` is an owner wake that ignores the on/off switch, `check` an
   * event wake on its topic), and the row's result is updated when the wake is over.
   */
  pickUpRequests(): void {
    if (this.stopped) return;
    try {
      for (const r of this.o.ax.listStewardRequests({ pending: true })) {
        const ax = this.o.ax;
        if (r.kind === "check" && r.topic !== null) {
          let on = false;
          try {
            on = ax.getTopicStewardEnabled(r.topic);
          } catch {
            // the topic is gone
          }
          if (!on) {
            ax.handleStewardRequest(
              r.id,
              "not run: the topic is gone or Steward is off for it",
              actor,
            );
            continue;
          }
        }
        ax.handleStewardRequest(r.id, "picked up", actor);
        const wake =
          r.kind === "run"
            ? this.requestWake("owner", "asked from the CLI: run now", { force: true })
            : this.requestWake(
                "event",
                r.requestedBy === "agent"
                  ? `asked by an agent: check ${r.topic}`
                  : `asked from the CLI: check ${r.topic}`,
                { topic: r.topic ?? undefined },
              );
        const note = (result: string) => {
          try {
            ax.handleStewardRequest(r.id, result, actor);
          } catch {
            // the database may be closed by now
          }
        };
        void wake.then(
          (w) => note(w ? `wake #${w.id} ${w.status}` : "no wake ran (Steward is off or stopped)"),
          (e) => note(`failed: ${e instanceof Error ? e.message : e}`),
        );
      }
    } catch (e) {
      console.error("steward request pickup failed:", e);
    }
  }

  /** The latest wake that read the world; a tidy-up of memory does not postpone the next one. */
  private lastRegularWake(): StewardWake | undefined {
    return this.o.ax.listStewardWakes(20).find((w) => w.trigger !== "tidy-up");
  }

  private timerWakeDue(s: StewardSettings): boolean {
    if (this.running || this.pending) return false;
    const last = this.lastRegularWake();
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
   * `opts.force` (the owner's Run now) runs it even while Steward is off.
   */
  requestWake(
    trigger: StewardWakeTrigger,
    detail: string | undefined,
    opts: { topic?: string; force?: boolean } = {},
  ): Promise<StewardWake | null> {
    if (this.stopped || !(this.settings().enabled || opts.force)) return Promise.resolve(null);
    if (this.running) {
      const p = this.pending;
      if (!p) {
        this.pending = newRequest(trigger, detail, opts.topic, opts.force);
      } else {
        if (RANK[trigger] > RANK[p.trigger]) p.trigger = trigger;
        if (detail) p.details.push(detail);
        if (p.topic !== opts.topic) p.topic = undefined;
        if (opts.force) p.force = true;
      }
      return (this.pending as WakeRequest).promise;
    }
    const req = newRequest(trigger, detail, opts.topic, opts.force);
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
        if (next && !this.stopped && (this.settings().enabled || next.force)) this.launch(next);
        else next?.resolve(null);
      });
  }

  /** Where this wake reads changes from: the last finished wake's start, else 24 hours back. */
  private lookBack(now: Date): Date {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const last = this.o.ax
      .listStewardWakes(20)
      .find((w) => w.status === "done" && w.trigger !== "tidy-up");
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

  /**
   * Whether the memory tidy-up is due (03, Decisions on memory): on the first wake of each local
   * day when something changed since the last one, and when the core is over its budget (at most
   * once an hour). Nothing to tidy, nothing spent.
   */
  tidyDue(now: Date): boolean {
    const { ax } = this.o;
    const items = ax.listStewardMemory();
    if (items.length === 0) return false;
    const last = ax.listStewardWakes(500).find((w) => w.trigger === "tidy-up");
    if (!last) return true;
    const overBudget =
      estimateTokens(items.filter((m) => m.scope === "core").map((m) => m.text)) >
      this.settings().memoryCoreTokens;
    if (overBudget && now.getTime() - Date.parse(last.startedAt) >= 3_600_000) return true;
    if (new Date(last.startedAt).toDateString() === now.toDateString()) return false;
    const since = last.endedAt ?? last.startedAt;
    return items.some((m) => m.updatedAt > since);
  }

  /**
   * Tidies the memory now, for the owner (an endpoint) and waits its turn behind a running wake.
   * Works whether Steward is on or off, since the owner asked. Rejects when there is no memory.
   */
  async tidyUpNow(detail = "asked by the owner"): Promise<StewardWake> {
    if (this.o.ax.listStewardMemory().length === 0) {
      throw new Error("Steward's memory is empty; there is nothing to tidy");
    }
    while (this.running) await this.idle;
    const req = newRequest("tidy-up", detail);
    this.launch(req);
    const w = await req.promise;
    if (!w) throw new Error("the tidy-up did not run");
    return w;
  }

  /** One tidy-up wake: the tidy-up stage alone. A failure changes nothing and is recorded. */
  private async executeTidyUp(detail: string | undefined): Promise<StewardWake> {
    const { ax } = this.o;
    const wake = ax.startStewardWake({ trigger: "tidy-up", triggerDetail: detail }, actor);
    this.o.bus?.emit();
    const end = (status: "done" | "failed" | "cut short", error?: string, r?: TidyResult) => {
      if (r) ax.setStewardWakeGathered(wake.id, { tidyUp: r }, actor);
      const w = ax.finishStewardWake(wake.id, { status, error }, actor);
      this.o.bus?.emit();
      return w;
    };
    try {
      const r = await runTidyUpStage({ ax, cli: this.cli(), env: this.o.env }, wake, this.now());
      return end(
        "done",
        r.refused.length ? `left alone, the owner's notes: ${r.refused.join("; ")}` : undefined,
        r,
      );
    } catch (e) {
      if (e instanceof StageError)
        return end(e.code === "cap" || e.code === "timeout" ? "cut short" : "failed", e.message);
      return end("failed", e instanceof Error ? e.message : String(e));
    }
  }

  private async execute(req: WakeRequest): Promise<StewardWake> {
    if (req.trigger === "tidy-up") return this.executeTidyUp(req.details.join("; ") || undefined);
    const { ax } = this.o;
    // The day's first wake begins with the memory tidy-up, its own wake; a failure is on record
    // and the wake goes on.
    if (this.tidyDue(this.now())) await this.executeTidyUp("first wake of the day");
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
      // Promotion (ST6): at most one prepared fix per wake. Its failures are notes on the finding.
      try {
        const findings = [...applied.created, ...applied.updated].filter(
          (i) => i.kind === "finding" && i.promotion,
        );
        if (findings.length > 0) {
          await runPromotion({ ctx, ghCli: this.o.ghCli, wake: gathered, findings });
        }
      } catch (e) {
        console.error("steward promotion failed:", e);
      }
      // Freshening branches (ST7), no model: rebase in place or as a copy where it is due.
      try {
        await runFreshen({ ax, wakeId: wake.id, topic: req.topic, env: this.o.env, now });
      } catch (e) {
        console.error("steward freshen failed:", e);
      }
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
