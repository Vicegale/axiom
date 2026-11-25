import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Axiom,
  defaultDatabasePath,
  describeToolUse,
  openDatabase,
  type RuntimePatch,
} from "@axiom/core";
import { readTranscriptRuntime } from "./transcript.js";

export const HOOK_EVENTS = [
  "session-start",
  "prompt",
  "pre-tool",
  "notification",
  "permission",
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
  prompt?: string;
  last_assistant_message?: unknown;
  tool_name?: string;
  tool_input?: unknown;
  transcript_path?: unknown;
  effort?: unknown;
}

/** The reasoning effort level a payload carries (`effort: {level: "high"}`), when it does. */
function effortLevel(p: HookPayload): string | undefined {
  const e = p.effort;
  if (typeof e !== "object" || e === null) return undefined;
  const level = (e as { level?: unknown }).level;
  return typeof level === "string" && level.trim() !== "" ? level.trim() : undefined;
}

/** The reply a Stop payload carries, when there is one. */
function lastReply(p: HookPayload): string | null {
  const m = p.last_assistant_message;
  return typeof m === "string" && m.trim() !== "" ? m : null;
}

export function hookLogPath(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "axiom", "hook.log");
}

export function logFailure(env: NodeJS.ProcessEnv, event: string, error: unknown): void {
  try {
    const path = hookLogPath(env);
    mkdirSync(dirname(path), { recursive: true });
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
    appendFileSync(path, `${new Date().toISOString()} ${event} ${message}\n`);
  } catch {
    // The hook must never break the agent, even when it cannot log.
  }
}

/** Running subagents listed in a Stop payload's `background_tasks` (background shells don't count). */
export function runningSubagentCount(p: HookPayload): number {
  const tasks = (p as { background_tasks?: unknown }).background_tasks;
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      (t as { type?: unknown }).type === "subagent" &&
      (t as { status?: unknown }).status === "running",
  ).length;
}

/**
 * Stores the session's effort (from the payload) and model and context (from the tail of its
 * transcript). Whatever is missing is left alone; a transcript that cannot be read is not an error.
 */
function recordRuntime(axiom: Axiom, threadId: number, payload: HookPayload): void {
  const patch: RuntimePatch = {};
  const effort = effortLevel(payload);
  if (effort) patch.effort = effort;
  if (typeof payload.transcript_path === "string" && payload.transcript_path !== "") {
    const t = readTranscriptRuntime(payload.transcript_path);
    if (t) {
      patch.model = t.model;
      patch.contextUsed = t.contextUsed;
      patch.contextMax = t.contextMax;
    }
  }
  axiom.setThreadRuntime(threadId, patch);
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
  // Axiom's own `claude -p` runs (the summaries) must never touch the database.
  if (env.AXIOM_INTERNAL === "1") return 0;
  // The permission hook waits for the owner: it is async and lives in permission.ts.
  if (event === "permission") return 0;
  try {
    if (!(HOOK_EVENTS as readonly string[]).includes(event))
      throw new Error(`unknown hook event "${event}"`);
    // T3 is the source of truth for T3 threads: do not record this session as a Claude Code
    // thread. If the T3 thread is attached, ask the server to re-read it now.
    const raw = (options.readStdin ?? (() => readFileSync(0, "utf8")))();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("hook payload is not a JSON object");
    }
    const payload = parsed as HookPayload;
    const subagents = runningSubagentCount(payload);

    // Runs before every tool call: one short write, no history, no notification, no refresh.
    if (event === "pre-tool") {
      if (typeof payload.tool_name !== "string" || payload.tool_name === "") return 0;
      const line = describeToolUse(payload.tool_name, payload.tool_input);
      const t3Id = env.T3CODE_THREAD_ID;
      const sessionId = payload.session_id || env.CLAUDE_CODE_SESSION_ID;
      if (!t3Id && !sessionId) return 0;
      const axiom = openDatabase(options.db ?? defaultDatabasePath(env));
      try {
        const thread = t3Id
          ? axiom.findThread({ provider: "t3", providerThreadId: t3Id })
          : axiom.findThread({ provider: "claude-code", providerThreadId: sessionId as string });
        if (thread && thread.endedAt === null) {
          axiom.setThreadActivity(thread.id, line);
          // T3 reports its own threads' effort; a direct session's comes with the payload.
          const effort = t3Id ? undefined : effortLevel(payload);
          if (effort) axiom.setThreadRuntime(thread.id, { effort });
        }
      } finally {
        axiom.close();
      }
      return 0;
    }

    const t3ThreadId = env.T3CODE_THREAD_ID;
    if (t3ThreadId) {
      const axiom = openDatabase(options.db ?? defaultDatabasePath(env));
      try {
        axiom.recordHookEvent();
        const thread = axiom.findThread({ provider: "t3", providerThreadId: t3ThreadId });
        if (thread) {
          if (event === "stop") {
            const reply = lastReply(payload);
            if (reply) axiom.setThreadReply(thread.id, reply);
            axiom.setRunningSubagents(thread.id, subagents);
            // The T3 sync may have seen the finished run first and stopped the thread already.
            if (
              subagents > 0 &&
              thread.endedAt === null &&
              axiom.getThread(thread.id).status !== "wip"
            ) {
              axiom.threadWorking(thread.id);
            }
          } else if (event === "session-end") {
            axiom.setRunningSubagents(thread.id, 0);
          }
          axiom.requestProviderRefresh("t3");
        }
      } finally {
        axiom.close();
      }
      return 0;
    }
    const sessionId = payload.session_id || env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new Error("hook payload has no session_id");

    const axiom = openDatabase(options.db ?? defaultDatabasePath(env));
    try {
      axiom.recordHookEvent();
      const thread = axiom.findThread({ provider: "claude-code", providerThreadId: sessionId });
      if (!thread) return 0; // not attached to a topic: ignored
      if (payload.cwd && axiom.threadCwd(thread.id) !== payload.cwd) {
        axiom.setThreadCwd(thread.id, payload.cwd);
      }
      switch (event as HookEvent) {
        case "pre-tool":
          break; // handled above
        case "session-start":
          axiom.threadReopened(thread.id);
          break;
        case "prompt":
          // A direct Claude Code session has no name of its own: the first prompt names it.
          if (!thread.title && payload.prompt) {
            axiom.fillThreadTitle(thread.id, payload.prompt.split("\n")[0] ?? "");
          }
          axiom.threadWorking(thread.id);
          break;
        case "notification":
          if (isPermissionRequest(payload)) {
            axiom.threadWaitingOnOwner(thread.id, payload.message || "Permission requested");
          }
          break;
        case "stop": {
          const reply = lastReply(payload);
          if (reply) axiom.setThreadReply(thread.id, reply);
          // Waiting on running subagents is not stopping: the thread stays wip until it is
          // re-invoked and stops again with none left.
          axiom.setRunningSubagents(thread.id, subagents);
          if (subagents === 0) axiom.threadStopped(thread.id);
          recordRuntime(axiom, thread.id, payload);
          break;
        }
        case "session-end":
          axiom.setRunningSubagents(thread.id, 0);
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
