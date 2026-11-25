import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultDatabasePath, openDatabase } from "@axiom/core";

export const HOOK_EVENTS = [
  "session-start",
  "prompt",
  "notification",
  "stop",
  "session-end",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The fields of Claude Code's hook payload that Axiom uses. */
interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
  reason?: string;
  cwd?: string;
}

export function hookLogPath(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "axiom", "hook.log");
}

function logFailure(env: NodeJS.ProcessEnv, event: string, error: unknown): void {
  try {
    const path = hookLogPath(env);
    mkdirSync(dirname(path), { recursive: true });
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
    appendFileSync(path, `${new Date().toISOString()} ${event} ${message}\n`);
  } catch {
    // The hook must never break the agent, even when it cannot log.
  }
}

/** A permission request, as opposed to an idle reminder or any other notification. */
function isPermissionRequest(p: HookPayload): boolean {
  if (p.notification_type !== undefined) return p.notification_type === "permission_prompt";
  return /permission/i.test(p.message ?? "");
}

/**
 * `axiom hook <event>`. Reads Claude Code's hook payload from stdin and records it on the attached
 * thread. Never throws and always returns 0: a failing hook must not disturb the agent. Failures
 * are appended to the hook log.
 */
export function runHook(
  event: string,
  env: NodeJS.ProcessEnv,
  options: { db?: string; readStdin?: () => string } = {},
): number {
  try {
    if (!(HOOK_EVENTS as readonly string[]).includes(event))
      throw new Error(`unknown hook event "${event}"`);
    // TODO(S6): T3 is the source of truth for T3 threads. Here, ask the T3 provider to re-read
    // thread `env.T3CODE_THREAD_ID` now. Until then these sessions are ignored.
    if (env.T3CODE_THREAD_ID) return 0;

    const raw = (options.readStdin ?? (() => readFileSync(0, "utf8")))();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("hook payload is not a JSON object");
    }
    const payload = parsed as HookPayload;
    const sessionId = payload.session_id || env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new Error("hook payload has no session_id");

    const axiom = openDatabase(options.db ?? defaultDatabasePath(env));
    try {
      const thread = axiom.findThread({ provider: "claude-code", providerThreadId: sessionId });
      if (!thread) return 0; // not attached to a topic: ignored
      switch (event as HookEvent) {
        case "session-start":
          axiom.threadReopened(thread.id);
          break;
        case "prompt":
          axiom.threadWorking(thread.id);
          break;
        case "notification":
          if (isPermissionRequest(payload)) {
            axiom.threadWaitingOnOwner(thread.id, payload.message || "Permission requested");
          }
          break;
        case "stop":
          axiom.threadStopped(thread.id);
          break;
        case "session-end":
          axiom.threadEnded(thread.id, payload.reason);
          break;
      }
    } finally {
      axiom.close();
    }
  } catch (error) {
    logFailure(env, event, error);
  }
  return 0;
}
