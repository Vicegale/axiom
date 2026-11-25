import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Axiom, Thread } from "@axiom/core";

const FETCH_TIMEOUT_MS = 20_000;
/** A failed fetch is tried again after this long (a successful one, only at the next stop). */
const RETRY_MS = 5 * 60_000;

export function defaultT3Cli(): string {
  return join(homedir(), ".t3", "bin", "t3");
}

/** The text of the last assistant message in `t3 thread show --json` output, or null. */
export function lastAssistantText(json: string): string | null {
  const data: unknown = JSON.parse(json);
  const root = (data ?? {}) as { messages?: unknown; thread?: { messages?: unknown } };
  const messages = Array.isArray(root.messages) ? root.messages : root.thread?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; text?: unknown } | null;
    if (m && m.role === "assistant" && typeof m.text === "string" && m.text.trim() !== "") {
      return m.text;
    }
  }
  return null;
}

function runT3(cli: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      args,
      { timeout: FETCH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
        else resolve(stdout);
      },
    );
  });
}

/** Open T3 threads that stopped (or are otherwise not running) after their stored reply. */
export function threadsNeedingReply(ax: Axiom): Thread[] {
  return ax
    .listProviderThreads("t3")
    .filter(
      (t) =>
        t.endedAt === null &&
        t.status !== "wip" &&
        (t.lastReplyAt === null || t.lastReplyAt < t.statusChangedAt),
    );
}

/**
 * Fetches the latest assistant message of T3 threads that stopped, with `t3 thread show`, and
 * stores it as the thread's reply. One fetch per stop (a failure is retried after a while); one
 * run at a time. Failures are logged and never thrown.
 */
export class T3ReplyFetcher {
  private running = false;
  private readonly attempts = new Map<number, { changedAt: string; at: number; ok: boolean }>();

  constructor(
    private readonly ax: Axiom,
    private readonly cli: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Returns how many replies were stored. */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let stored = 0;
    try {
      for (const th of threadsNeedingReply(this.ax)) {
        const last = this.attempts.get(th.id);
        if (
          last &&
          last.changedAt === th.statusChangedAt &&
          (last.ok || this.now().getTime() - last.at < RETRY_MS)
        ) {
          continue;
        }
        let ok = true;
        try {
          const text = lastAssistantText(
            await runT3(this.cli(), [
              "thread",
              "show",
              th.providerThreadId,
              "--messages",
              "1",
              "--json",
            ]),
          );
          if (text !== null) {
            const before = this.ax.getThread(th.id).lastReplyAt;
            this.ax.setThreadReply(th.id, text);
            if (this.ax.getThread(th.id).lastReplyAt !== before) stored++;
          }
        } catch (e) {
          ok = false;
          console.error(
            `T3 reply fetch failed for thread ${th.id} (${th.providerThreadId}):`,
            e instanceof Error ? e.message : e,
          );
        }
        this.attempts.set(th.id, { changedAt: th.statusChangedAt, at: this.now().getTime(), ok });
      }
    } catch (e) {
      console.error("T3 reply fetch failed:", e);
    } finally {
      this.running = false;
    }
    return stored;
  }
}
