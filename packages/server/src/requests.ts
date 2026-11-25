/**
 * Answering agents from the Desk card (docs/plan/desk.md, D5).
 *
 * - T3 questions (`user_input`): answered through T3's MCP endpoint (`POST http://127.0.0.1:<port>/mcp`,
 *   streamable HTTP, JSON-RPC): `initialize`, `notifications/initialized`, then `tools/call`
 *   `t3_pending_request` `{ action: "respond", threadId, requestId, answers }`. The bearer token is
 *   minted per action with `t3 auth session issue` (5 minutes, subject `mcp-client`, which is what
 *   T3's MCP endpoint accepts), used once, revoked, and never stored or logged.
 * - T3 permission approvals: T3's MCP tool "cannot approve a permission request", so the card
 *   offers `Open in T3` (the deep link).
 * - Claude Code approvals: rows in the `approval` table, written by the `PermissionRequest` hook,
 *   which polls for the owner's decision made here.
 */
import { type Actor, type Approval, type Axiom, AxiomError, type Thread } from "@axiom/core";
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

/** The text of an MCP response: plain JSON, or the first `data:` event of an event stream. */
function rpcPayload(text: string, contentType: string | null): unknown {
  if (contentType?.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data) return JSON.parse(data);
      }
    }
    return undefined;
  }
  return text.trim() === "" ? undefined : JSON.parse(text);
}

/**
 * Calls one tool of T3's MCP server and returns its result. Throws `ProviderError` with a reason
 * when T3 refuses, is unreachable, or the tool reports an error. The token never appears in the
 * message.
 */
export async function callT3Tool(
  origin: string,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = `${origin}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  const post = async (body: unknown, extra: Record<string, string> = {}) => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ProviderError(
        `cannot reach T3 at ${origin}: ${(e instanceof Error ? e.message : String(e)).replace(token, "***")}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      const why = text.replace(token, "***").slice(0, 300);
      throw new ProviderError(`T3 refused the request (${res.status})${why ? `: ${why}` : ""}`);
    }
    let payload: unknown;
    try {
      payload = rpcPayload(text, res.headers.get("content-type"));
    } catch {
      throw new ProviderError("T3 sent a reply Axiom cannot read");
    }
    return { res, payload };
  };

  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "axiom", version: "1" },
    },
  });
  const sid = init.res.headers.get("mcp-session-id");
  const session: Record<string, string> = sid ? { "mcp-session-id": sid } : {};
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const call = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    session,
  );
  const msg = (call.payload ?? {}) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown };
  };
  if (msg.error) throw new ProviderError(`T3 error: ${msg.error.message ?? "unknown"}`);
  if (msg.result?.isError) {
    let why = msg.result.content?.[0]?.text ?? "the tool failed";
    try {
      const j = JSON.parse(why) as { message?: string };
      if (typeof j.message === "string") why = j.message;
    } catch {}
    throw new ProviderError(`T3: ${why}`.slice(0, 400));
  }
  return msg.result?.structuredContent ?? msg.result;
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
      openUrl: isQuestion ? null : t3.threadUrl(th.providerThreadId, th.environmentId),
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
    const decided = ax.decideApproval(id, body.decision, body.message, owner);
    bus.emit();
    return c.json(decided);
  });

  /** A 5-minute token (and its session id, to revoke it). Never logged. */
  async function mint(): Promise<{ token: string; sessionId: string | null }> {
    const r = await runCapture(
      t3Cli(),
      [
        "auth",
        "session",
        "issue",
        "--scope",
        "orchestration:read",
        "--scope",
        "orchestration:operate",
        "--ttl",
        TOKEN_TTL,
        "--label",
        "axiom",
        "--subject",
        "mcp-client",
        "--json",
      ],
      "",
      { timeoutMs: CLI_TIMEOUT_MS },
    );
    if (r.code !== 0) throw failure("t3 auth session issue", { ...r, stdout: "" });
    try {
      const j = JSON.parse(r.stdout) as { token?: unknown; sessionId?: unknown };
      if (typeof j.token === "string" && j.token) {
        return { token: j.token, sessionId: typeof j.sessionId === "string" ? j.sessionId : null };
      }
    } catch {}
    throw new ProviderError("t3 auth session issue printed no token");
  }

  async function revoke(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    try {
      await runCapture(t3Cli(), ["auth", "session", "revoke", sessionId], "", {
        timeoutMs: CLI_TIMEOUT_MS,
      });
    } catch {} // it expires by itself in minutes
  }

  const answerText = (v: string | string[]) => (Array.isArray(v) ? v.join(", ") : v);

  app.post("/api/threads/:id/requests/:requestId/answer", async (c) => {
    const th = thread(c);
    const requestId = c.req.param("requestId") ?? "";
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AxiomError("validation", "request body must be valid JSON");
    }
    const { answers } = parse(bodies.answer, raw);
    if (th.provider !== "t3") {
      throw new AxiomError("validation", "only T3 questions are answered this way");
    }
    let request: T3Request | undefined;
    try {
      request = t3.pendingRequests(th.providerThreadId).find((r) => r.id === requestId);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return c.json({ error: { code: "unavailable", message: `T3 cannot be read: ${why}` } }, 503);
    }
    if (request?.kind !== "user_input") {
      throw new AxiomError("conflict", "This question is no longer waiting (answered elsewhere?).");
    }
    const known = new Set(request.questions.map((q) => q.id));
    for (const key of Object.keys(answers)) {
      if (!known.has(key)) throw new AxiomError("validation", `no such question: ${key}`);
    }
    const port = t3.port();
    if (port === null) {
      return c.json(
        { error: { code: "provider", message: "T3 does not seem to be running" } },
        502,
      );
    }
    let minted: { token: string; sessionId: string | null } | undefined;
    try {
      minted = await mint();
      await callT3Tool(
        `http://127.0.0.1:${port}`,
        minted.token,
        "t3_pending_request",
        { action: "respond", threadId: th.providerThreadId, requestId, answers },
        o.fetchImpl,
      );
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      return c.json({ error: { code: "provider", message: e.message } }, 502);
    } finally {
      await revoke(minted?.sessionId ?? null);
    }
    // What the owner decided is history.
    for (const q of request.questions) {
      const a = answers[q.id];
      if (a === undefined) continue;
      ax.addEntry(
        th.topicId,
        { kind: "owner input", body: `Answered "${q.question.slice(0, 200)}": ${answerText(a)}` },
        owner,
      );
    }
    ax.requestProviderRefresh("t3");
    bus.emit();
    return c.json({ ok: true });
  });
}
