import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** What the tail of a Claude Code transcript says about the session's model and context. */
export interface TranscriptRuntime {
  model: string;
  contextUsed: number;
  contextMax: number | null;
}

/** How much of the end of the transcript is read: transcripts grow to many megabytes. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** The context window of Claude 5 models (what T3 reports for them) and of `[1m]` models. */
const MILLION = 1_000_000;

/** The context window size of a model id, or null when it is not known. */
export function contextMaxOf(model: string): number | null {
  return /^claude-[a-z]+-5/.test(model) || model.includes("[1m]") ? MILLION : null;
}

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/** Reads at most `bytes` from the end of a file as text; null when it cannot be read. */
function readTail(path: string, bytes: number): { text: string; partialStart: boolean } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString("utf8"), partialStart: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/**
 * The model and context size of the newest assistant message of the main conversation, read from
 * the tail of a transcript (JSONL). A missing file, a partial first line, malformed lines and
 * messages without `usage` (or from subagents, or synthetic) are skipped. Context is
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Never throws.
 */
export function readTranscriptRuntime(
  path: string,
  bytes = TRANSCRIPT_TAIL_BYTES,
): TranscriptRuntime | null {
  const tail = readTail(path, bytes);
  if (!tail) return null;
  const lines = tail.text.split("\n");
  // The first line of a tail that starts mid-file is cut off.
  if (tail.partialStart) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; isSidechain?: unknown; message?: unknown };
    if (e.isSidechain === true) continue;
    const m = e.message as
      | { role?: unknown; model?: unknown; usage?: Record<string, unknown> | null }
      | undefined;
    if (typeof m !== "object" || m === null) continue;
    if (e.type !== "assistant" && m.role !== "assistant") continue;
    if (typeof m.usage !== "object" || m.usage === null) continue;
    if (typeof m.model !== "string" || m.model === "" || m.model.startsWith("<")) continue;
    const u = m.usage;
    return {
      model: m.model,
      contextUsed:
        count(u.input_tokens) +
        count(u.cache_creation_input_tokens) +
        count(u.cache_read_input_tokens),
      contextMax: contextMaxOf(m.model),
    };
  }
  return null;
}
