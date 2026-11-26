/**
 * Answering agents from the Desk card (docs/plan/desk.md, D5).
 *
 * - T3 questions (`user_input`): T3 refuses answers from outside its own app, so the card shows
 *   one short Haiku bullet per question (question-summaries.ts) and `Open in T3` (the deep link).
 * - T3 permission approvals: T3's MCP tool "cannot approve a permission request", so the card
 *   offers `Open in T3` too.
 * - Claude Code approvals: rows in the `approval` table, written by the `PermissionRequest` hook,
 *   which polls for the owner's decision made here.
 */
import {
  type Actor,
  type Approval,
  type Axiom,
  AxiomError,
  describePermissionUpdate,
  type Thread,
} from "@axiom/core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { ChangeBus } from "./events.js";
import type { T3Provider } from "./providers/t3/provider.js";
import type { T3Question, T3Request } from "./providers/t3/reader.js";
import { defaultT3Cli } from "./providers/t3/replies.js";
import { failure, ProviderError, runCapture } from "./sending.js";

const owner: Actor = { kind: "owner" };
const TOKEN_TTL = "5m";
const CLI_TIMEOUT_MS = 20_000;
const MCP_TIMEOUT_MS = 20_000;

/** One thing waiting on the owner, as the card shows it. */
export interface PendingRequest {
  /** T3's request id, or the approval id (as text) for Claude Code. */
  id: string;
  provider: "t3" | "claude-code";
  kind: "question" | "approval";
  /** The question text, or the tool and its one-line input. */
  text: string;
  questions: T3Question[];
  tool: string | null;
  summary: string | null;
  /** What T3 says an approval is about (`command`, ...). */
  requestKind: string | null;
  createdAt: string | null;
  /** The owner can allow or deny it here (Claude Code), not only open the thread (T3 approvals). */
  decidable: boolean;
  /** `t3code://` link of the thread, for approvals T3 must answer. */
  openUrl: string | null;
  /**
   * Claude Code approvals: the "don't ask again" choices Claude Code offered, as the card labels
   * them; `index` goes back as `suggestion` with an allow.
   */
  choices: { index: number; label: string }[];
}

export interface RequestsOptions {
  ax: Axiom;
  bus: ChangeBus;
  t3: T3Provider;
  t3Cli?: string;
  /** Replaces `fetch` for the MCP call (tests). */
  fetchImpl?: typeof fetch;
}

const bodies = {
  answer: z.strictObject({
    answers: z
      .record(z.string().min(1), z.union([z.string(), z.array(z.string())]))
      .refine((a) => Object.keys(a).length > 0, "answers are required"),
  }),
  decision: z.strictObject({
    decision: z.enum(["allow", "deny"]),
    message: z.string().max(500).optional(),
    /** Allow only: also send this "don't ask again" choice (an index into `choices`). */
    suggestion: z.number().int().min(0).optional(),
  }),
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AxiomError(
      "validation",
      r.error.issues
        .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
        .join("; "),
    );
  }
  return r.data;
}

function intParam(value: string, what: string): number {
  if (!/^\d+$/.test(value)) throw new AxiomError("validation", `${what} must be an integer`);
  return Number(value);
}

/** Is the hook process still there to hear the decision? A hook without a pid counts as alive. */
export function hookAlive(a: Pick<Approval, "hookPid">): boolean {
  if (a.hookPid === null) return true;
  try {
    process.kill(a.hookPid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pending approvals whose hook is still waiting; abandoned ones (the owner answered in the
 * terminal, the hook was killed) are closed as expired. `changed` says whether any was.
 */
export function livePendingApprovals(
  ax: Axiom,
  threadId: number,
): { live: Approval[]; changed: boolean } {
  const live: Approval[] = [];
  let changed = false;
  for (const a of ax.pendingApprovals(threadId)) {
    if (hookAlive(a)) live.push(a);
    else {
      ax.expireApproval(a.id);
      changed = true;
    }
  }
  return { live, changed };
}

export function registerRequestRoutes(app: Hono, o: RequestsOptions): void {
  const { ax, bus, t3 } = o;
  const t3Cli = () => {
    const s = ax.getSetting("t3Cli");
    return typeof s === "string" && s ? s : (o.t3Cli ?? defaultT3Cli());
  };

  const thread = (c: Context): Thread =>
    ax.getThread(intParam(c.req.param("id") ?? "", "thread id"));

  const livePending = (threadId: number): Approval[] => {
    const { live, changed } = livePendingApprovals(ax, threadId);
    if (changed) bus.emit();
    return live;
  };

  const fromT3 = (th: Thread, r: T3Request): PendingRequest => {
    const isQuestion = r.kind === "user_input";
    return {
      id: r.id,
      provider: "t3",
      kind: isQuestion ? "question" : "approval",
      text: r.text,
      questions: r.questions,
      tool: null,
      summary: isQuestion ? null : r.text,
      requestKind: r.requestKind,
      createdAt: null,
      decidable: false,
      // Always offered: T3 may refuse answers from outside its own app (see the answer route).
      openUrl: t3.threadUrl(th.providerThreadId, th.environmentId),
      choices: [],
    };
  };

  const fromApproval = (a: Approval): PendingRequest => ({
    id: String(a.id),
    provider: "claude-code",
    kind: "approval",
    text: `${a.toolName}: ${a.inputSummary}`,
    questions: [],
    tool: a.toolName,
    summary: a.inputSummary,
    requestKind: null,
    createdAt: a.createdAt,
    decidable: true,
    openUrl: null,
    choices: a.suggestions.map((u, index) => ({ index, label: describePermissionUpdate(u) })),
  });

  app.get("/api/threads/:id/requests", (c) => {
    const th = thread(c);
    if (th.provider === "claude-code") {
      return c.json({ requests: livePending(th.id).map(fromApproval) });
    }
    try {
      return c.json({
        requests: t3.pendingRequests(th.providerThreadId).map((r) => fromT3(th, r)),
      });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return c.json({ error: { code: "unavailable", message: `T3 cannot be read: ${why}` } }, 503);
    }
  });

  app.get("/api/threads/:id/approvals", (c) => {
    const th = thread(c);
    return c.json({ approvals: livePending(th.id) });
  });

  app.post("/api/approvals/:id", async (c) => {
    const id = intParam(c.req.param("id"), "approval id");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AxiomError("validation", "request body must be valid JSON");
    }
    const body = parse(bodies.decision, raw);
    const a = ax.getApproval(id);
    if (a.decidedAt === null && !hookAlive(a)) {
      ax.expireApproval(id);
      bus.emit();
      throw new AxiomError(
        "conflict",
        "The agent is no longer waiting for this (it was answered in the terminal or timed out).",
      );
    }
    const decided = ax.decideApproval(id, body.decision, body.message, owner, {
      suggestion: body.suggestion,
    });
    bus.emit();
    return c.json(decided);
  });
}
