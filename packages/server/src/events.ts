import type { DatabaseSync } from "node:sqlite";

export const POLL_MS = 300;

type Listener = (at: string) => void;

/**
 * Fans out "something changed" to SSE subscribers. Changes made by other processes (the CLI)
 * are noticed by polling `PRAGMA data_version` on the server's own connection; that value only
 * moves for commits made by other connections, so the server announces its own writes itself.
 */
export class ChangeBus {
  private readonly listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | undefined;
  private last: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date,
    pollMs = POLL_MS,
  ) {
    this.last = this.dataVersion();
    this.timer = setInterval(() => {
      const v = this.dataVersion();
      if (v !== this.last) {
        this.last = v;
        this.emit();
      }
    }, pollMs);
  }

  private dataVersion(): number {
    const row = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    return row.data_version;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    const at = this.clock().toISOString();
    for (const fn of this.listeners) fn(at);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
