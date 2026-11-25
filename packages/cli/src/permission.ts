/**
 * `axiom hook permission`: Claude Code's `PermissionRequest` hook (docs/plan/desk.md, D5).
 *
 * Claude Code runs this hook when it is about to show a permission prompt. If the session is
 * attached to a topic, the request is recorded as a pending approval (the Desk card shows it)
 * and the hook waits, polling the database, for the owner's decision. On a decision it prints
 * Claude Code's decision JSON; on a timeout, a cancellation or any error it prints nothing and
 * exits 0, so Claude Code shows its normal terminal prompt. Never throws.
 *
 * Verified 2026-11-25 with `claude -p` (Claude Code 2.x) and a throwaway settings file: stdout
 * `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
 * runs the tool; `{"behavior":"deny","message":"..."}` blocks it and the model sees the message;
 * printing nothing falls back to the normal prompt (denied in `-p`, which has no terminal).
 */
import { readFileSync } from "node:fs";
import {
  type Axiom,
  DEFAULT_APPROVAL_TIMEOUT_SEC,
  defaultDatabasePath,
  describeToolUse,
  openDatabase,
} from "@axiom/core";
import { logFailure } from "./hook.js";

const POLL_MS = 500;

export interface PermissionOptions {
  db?: string;
  readStdin?: () => string;
  /** Where the decision JSON goes (default: stdout). */
  write?: (text: string) => void;
  pollMs?: number;
  /** Replaces the wait between polls (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the `approvalTimeoutSec` setting, in milliseconds (tests). */
  timeoutMs?: number;
  /** Do not listen for SIGTERM/SIGINT (tests running in a shared process). */
  noSignals?: boolean;
}

interface PermissionPayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export function decisionJson(decision: "allow" | "deny", message?: string): string {
  const d = decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message };
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d },
  });
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runPermissionHook(
  env: NodeJS.ProcessEnv,
  options: PermissionOptions = {},
): Promise<number> {
  // Axiom's own `claude -p` runs, and sessions T3 runs (T3 asks the owner itself): hands off.
  if (env.AXIOM_INTERNAL === "1" || env.T3CODE_THREAD_ID) return 0;
  let axiom: Axiom | undefined;
  let approvalId: number | undefined;
  let cancelled = false;
  const onSignal = () => {
    cancelled = true;
  };
  try {
    const raw = (options.readStdin ?? (() => readFileSync(0, "utf8")))();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
    const payload = parsed as PermissionPayload;
    const sessionId = payload.session_id || env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId || typeof payload.tool_name !== "string" || payload.tool_name === "") return 0;

    axiom = openDatabase(options.db ?? defaultDatabasePath(env));
    axiom.recordHookEvent();
    const thread = axiom.findThread({ provider: "claude-code", providerThreadId: sessionId });
    if (!thread) return 0; // not attached to a topic: Claude Code asks in the terminal

    const approval = axiom.requestApproval(thread.id, {
      toolName: payload.tool_name,
      inputSummary: describeToolUse(payload.tool_name, payload.tool_input),
      hookPid: process.pid,
    });
    approvalId = approval.id;

    if (!options.noSignals) {
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
    }
    const setting = axiom.getSetting("approvalTimeoutSec");
    const timeoutMs =
      options.timeoutMs ??
      (typeof setting === "number" && setting > 0 ? setting : DEFAULT_APPROVAL_TIMEOUT_SEC) * 1000;
    const pollMs = options.pollMs ?? POLL_MS;
    const sleep = options.sleep ?? sleepFor;
    const write = options.write ?? ((t: string) => void process.stdout.write(t));
    const started = Date.now();

    while (!cancelled && Date.now() - started < timeoutMs) {
      await sleep(pollMs);
      const a = axiom.getApproval(approval.id);
      if (a.decidedAt === null) continue;
      if (a.decision === "allow" || a.decision === "deny") {
        write(decisionJson(a.decision, a.message ?? "Denied by the owner in Axiom"));
        // The agent carries on: it is working again, not waiting on the owner.
        const th = axiom.getThread(thread.id);
        if (th.status === "hitl" && th.waitingOnOwner) axiom.threadWorking(thread.id);
        approvalId = undefined;
      }
      return 0;
    }
    return 0; // timed out or cancelled: the finally block expires it; the terminal prompt follows
  } catch (error) {
    logFailure(env, "permission", error);
    return 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    try {
      if (axiom && approvalId !== undefined) axiom.expireApproval(approvalId);
    } catch {}
    try {
      axiom?.close();
    } catch {}
  }
}
