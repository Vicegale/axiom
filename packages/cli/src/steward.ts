import {
  type Actor,
  AxiomError,
  memoryForTopic,
  resolveAttachedKey,
  type StewardAttachedKind,
  type StewardItemKind,
  type StewardItemWithFix,
  type StewardMemory,
  type StewardMemoryScope,
  type StewardRequest,
} from "@axiom/core";
import { type Command, Option } from "commander";
import { type Context, parseId, UsageError } from "./context.js";
import { stewardItemJson, table, when } from "./format.js";
import type { Handler } from "./program.js";

/**
 * `axiom steward ...` (ST10). Agents and the owner read Steward's state; an agent may also ask for
 * a check of one topic; the owner switches Steward on and off, asks for a run and keeps its memory.
 * The CLI never runs a wake: `check` and `run` write a request the server's scheduler picks up.
 */

interface Registrar {
  sub: (parent: Command, name: string, description: string) => Command;
  run: (handler: Handler) => (...received: unknown[]) => void;
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Refuses an agent (and anything but the owner) with a message that says who to ask. */
function ownerOnly(ctx: Context, what: string): Actor {
  const actor = ctx.actor;
  if (actor.kind !== "owner") {
    throw new AxiomError("permission", `Only the owner can ${what}; ask them.`);
  }
  return actor;
}

/** The server is running when its scheduler's beat is fresh (it beats on every tick, ~30 s). */
function serverState(ctx: Context) {
  const beat = ctx.axiom.getStewardServerBeat();
  return {
    running: beat !== null,
    pid: beat?.pid ?? null,
    lastBeatAt: beat?.at ?? null,
    nextWakeAt: beat?.nextWakeAt ?? null,
  };
}

const NO_SERVER =
  "The Axiom server is not running, so the request waits until it starts (axiom server start).";

export function itemsText(items: readonly StewardItemWithFix[]): string {
  if (items.length === 0) return "No Steward items.";
  return items
    .map((i) => {
      const head = [`#${i.id}`, i.kind, i.level ?? "-", i.topicSlug ?? "-", i.title];
      const lines = [head.join("  ")];
      if (i.state !== "open") lines[0] += `  (${i.state})`;
      if (i.body) lines.push(`    ${clip(i.body, 160)}`);
      if (i.fixBranch) lines.push(`    fix ready: ${i.fixBranch}`);
      return lines.join("\n");
    })
    .join("\n");
}

function memoryText(items: readonly StewardMemory[]): string {
  if (items.length === 0) return "No Steward memory.";
  return items
    .map((m) => {
      const where = m.attachedKey ? `${m.attachedKind}:${m.attachedKey}` : "-";
      return `#${m.id}  ${m.scope}  ${where}  ${m.source}${m.retiredAt ? "  retired" : ""}\n    ${m.text.replace(/\n/g, "\n    ")}`;
    })
    .join("\n");
}

function parseAttach(text: string): { kind: StewardAttachedKind; key: string } {
  const i = text.indexOf(":");
  const kind = text.slice(0, i);
  if (i <= 0 || (kind !== "topic" && kind !== "repo" && kind !== "person") || !text.slice(i + 1)) {
    throw new UsageError(
      `invalid --attach "${text}" (expected topic:<slug>, repo:<name> or person:<name>)`,
    );
  }
  return { kind, key: text.slice(i + 1) };
}

function requestJson(r: StewardRequest) {
  return r;
}

export function registerSteward(program: Command, { sub, run }: Registrar): void {
  const steward = sub(program, "steward", "see Steward's state and ask it for a check");

  sub(steward, "status", "on or off, running, next wake, open items, last wake").action(
    run((ctx) => {
      const ax = ctx.axiom;
      const settings = ax.getStewardSettings();
      const server = serverState(ctx);
      const running = ax.runningStewardWake();
      const last = ax.listStewardWakes(1)[0] ?? null;
      const items = ax.listStewardItemsWithFix();
      const findings = (level: string) =>
        items.filter((i) => i.kind === "finding" && i.level === level).length;
      const counts = {
        questions: items.filter((i) => i.kind === "question").length,
        findings: {
          urgent: findings("urgent"),
          attention: findings("attention"),
          info: findings("info"),
        },
        suggestions: items.filter((i) => i.kind === "suggestion").length,
      };
      const pending = ax.listStewardRequests({ pending: true }).length;
      const next = settings.enabled ? server.nextWakeAt : null;
      const data = {
        enabled: settings.enabled,
        running: running !== null,
        server,
        nextWakeAt: next,
        lastWake: last && {
          id: last.id,
          trigger: last.trigger,
          startedAt: last.startedAt,
          endedAt: last.endedAt,
          status: last.status,
          error: last.error,
        },
        counts,
        pendingRequests: pending,
      };
      const nextText = !settings.enabled
        ? "-"
        : next
          ? when(next)
          : server.running
            ? "none due (outside working hours or no working day set)"
            : "the server computes it; it is not running";
      const text = [
        `Steward:       ${settings.enabled ? "on" : "off"}${running ? ", running a wake now" : ""}`,
        `Server:        ${server.running ? `running (pid ${server.pid})` : "not running"}`,
        `Next wake:     ${nextText}`,
        `Last wake:     ${last ? `#${last.id} ${when(last.startedAt)} ${last.trigger} ${last.status}${last.error ? ` (${clip(last.error, 100)})` : ""}` : "none yet"}`,
        `Open:          ${plural(counts.questions, "question")}, findings ${counts.findings.urgent} urgent / ${counts.findings.attention} attention / ${counts.findings.info} info, ${plural(counts.suggestions, "suggestion")}`,
        ...(pending ? [`Requests:      ${plural(pending, "request")} waiting for the server`] : []),
      ].join("\n");
      return { data, text };
    }),
  );

  sub(steward, "usage", "tokens used today per model family against the daily caps").action(
    run((ctx) => {
      const usage = ctx.axiom.stewardUsageByFamily();
      if (usage.length === 0) return { data: usage, text: "No usage today." };
      const rows = usage.map((u) => [
        u.family,
        `${u.used.toLocaleString("en-US")} tokens`,
        u.cap === null ? "no cap" : `of ${u.cap.toLocaleString("en-US")}`,
        plural(u.runs, "run"),
      ]);
      return { data: usage, text: table(rows) };
    }),
  );

  sub(steward, "items", "Steward's open items (findings, questions, suggestions)")
    .option("--topic <slug>", "only this topic")
    .addOption(
      new Option("--kind <kind>", "only one kind").choices(["finding", "question", "suggestion"]),
    )
    .option("--all", "include items that are no longer open")
    .action(
      run((ctx, _a, o) => {
        const items = ctx.axiom.listStewardItemsWithFix({
          state: o.all ? "all" : "open",
          ...(o.topic ? { topic: o.topic } : {}),
          ...(o.kind ? { kind: o.kind as StewardItemKind } : {}),
        });
        return { data: items.map(stewardItemJson), text: itemsText(items) };
      }),
    );

  // ---- memory ----------------------------------------------------------------
  const memory = sub(
    steward,
    "memory",
    "Steward's memory (reading is open; changes are the owner's)",
  )
    .option("--topic <slug>", "the core plus what is attached to this topic and its repositories")
    .addOption(
      new Option("--scope <scope>", "only one scope").choices(["core", "attached", "general"]),
    )
    .option("--retired", "include retired items");
  memory.action(
    run((ctx, _a, o) => {
      const ax = ctx.axiom;
      let items = o.topic
        ? memoryForTopic(ax, o.topic, { includeRetired: Boolean(o.retired) })
        : ax.listStewardMemory({ includeRetired: Boolean(o.retired) });
      if (o.scope) items = items.filter((m) => m.scope === (o.scope as StewardMemoryScope));
      return { data: items, text: memoryText(items) };
    }),
  );

  sub(memory, "add", "add a memory item (owner only)")
    .argument("<text>", "what Steward should remember")
    .addOption(
      new Option("--scope <scope>", "core, attached or general").choices([
        "core",
        "attached",
        "general",
      ]),
    )
    .option("--attach <what>", "topic:<slug>, repo:<name> or person:<name> (makes it attached)")
    .action(
      run((ctx, [text], o) => {
        const actor = ownerOnly(ctx, "add to Steward's memory");
        const scope = (o.scope ?? (o.attach ? "attached" : "core")) as StewardMemoryScope;
        if (scope === "attached" && !o.attach) {
          throw new UsageError(
            "attached memory needs --attach topic:<slug>|repo:<name>|person:<name>",
          );
        }
        if (scope !== "attached" && o.attach) {
          throw new UsageError("--attach goes with the attached scope");
        }
        let attached: { attachedKind: StewardAttachedKind; attachedKey: string } | undefined;
        if (o.attach) {
          const a = parseAttach(o.attach);
          try {
            attached = {
              attachedKind: a.kind,
              attachedKey: resolveAttachedKey(ctx.axiom, a.kind, a.key),
            };
          } catch (e) {
            throw new AxiomError("validation", e instanceof Error ? e.message : String(e));
          }
        }
        const m = ctx.axiom.addStewardMemory({ scope, ...attached, text: text as string }, actor);
        return { data: m, text: `Added memory #${m.id} (${m.scope}).` };
      }),
    );

  sub(memory, "edit", "change a memory item's text (owner only)")
    .argument("<id>", "memory item id")
    .argument("<text>", "the new text")
    .action(
      run((ctx, [id, text]) => {
        const actor = ownerOnly(ctx, "change Steward's memory");
        const m = ctx.axiom.updateStewardMemory(
          parseId(id as string, "memory id"),
          text as string,
          actor,
        );
        return { data: m, text: `Changed memory #${m.id}.` };
      }),
    );

  const byId = (
    name: string,
    description: string,
    what: string,
    past: string,
    act: (ctx: Context, id: number, actor: Actor) => StewardMemory | undefined,
  ) =>
    sub(memory, name, description)
      .argument("<id>", "memory item id")
      .action(
        run((ctx, [id]) => {
          const actor = ownerOnly(ctx, what);
          const n = parseId(id as string, "memory id");
          const m = act(ctx, n, actor);
          return { data: m ?? { id: n, deleted: true }, text: `${past} memory #${n}.` };
        }),
      );
  byId(
    "retire",
    "stop loading a memory item, keep it (owner only)",
    "retire a memory item",
    "Retired",
    (c, id, a) => c.axiom.retireStewardMemory(id, a),
  );
  byId(
    "restore",
    "load a retired memory item again (owner only)",
    "restore a memory item",
    "Restored",
    (c, id, a) => c.axiom.restoreStewardMemory(id, a),
  );
  byId(
    "delete",
    "delete a memory item for good (owner only)",
    "delete a memory item",
    "Deleted",
    (c, id, a) => {
      c.axiom.deleteStewardMemory(id, a);
      return undefined;
    },
  );

  // ---- asking the server ----------------------------------------------------------
  sub(
    steward,
    "check",
    "ask Steward to look at one topic now (at most once per topic every 10 minutes)",
  )
    .argument("<topic>", "topic slug")
    .action(
      run((ctx, [topic]) => {
        const r = ctx.axiom.requestStewardWake(
          { kind: "check", topic: topic as string },
          ctx.actor,
        );
        const server = serverState(ctx);
        return {
          data: { request: requestJson(r), server },
          text: `Asked Steward to check ${r.topic} (request #${r.id}).${server.running ? "" : `\n${NO_SERVER}`}`,
        };
      }),
    );

  sub(steward, "run", "run a full wake now, even while Steward is off (owner only)").action(
    run((ctx) => {
      const actor = ownerOnly(ctx, "run Steward now");
      const r = ctx.axiom.requestStewardWake({ kind: "run" }, actor);
      const server = serverState(ctx);
      return {
        data: { request: requestJson(r), server },
        text: `Asked Steward to run now (request #${r.id}).${server.running ? "" : `\n${NO_SERVER}`}`,
      };
    }),
  );

  for (const on of [true, false]) {
    sub(steward, on ? "on" : "off", `switch Steward ${on ? "on" : "off"} (owner only)`).action(
      run((ctx) => {
        const actor = ownerOnly(ctx, `switch Steward ${on ? "on" : "off"}`);
        const s = ctx.axiom.setStewardSettings({ enabled: on }, actor);
        return { data: { enabled: s.enabled }, text: `Steward is ${s.enabled ? "on" : "off"}.` };
      }),
    );
  }
}
