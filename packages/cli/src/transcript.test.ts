import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contextMaxOf, readTranscriptRuntime } from "./transcript.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-transcript-"));
  mkdirSync(dir, { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function write(lines: (object | string)[]): string {
  const path = join(dir, `t-${n++}.jsonl`);
  writeFileSync(
    path,
    `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`,
  );
  return path;
}

const assistant = (model: string, usage: object | null, extra: object = {}) => ({
  type: "assistant",
  message: { role: "assistant", model, ...(usage ? { usage } : {}) },
  ...extra,
});

describe("contextMaxOf", () => {
  it("is a million for Claude 5 and [1m] models, otherwise unknown", () => {
    expect(contextMaxOf("claude-opus-5-5")).toBe(1_000_000);
    expect(contextMaxOf("claude-sonnet-5-0")).toBe(1_000_000);
    expect(contextMaxOf("claude-opus-4-1[1m]")).toBe(1_000_000);
    expect(contextMaxOf("claude-opus-4-1")).toBeNull();
    expect(contextMaxOf("gpt-5.4")).toBeNull();
  });
});

describe("readTranscriptRuntime", () => {
  it("sums input, cache-creation and cache-read tokens of the last assistant message", () => {
    const path = write([
      { type: "user", message: { role: "user", content: "hi" } },
      assistant("claude-haiku-4-5", { input_tokens: 1, output_tokens: 1 }),
      assistant("claude-opus-5-5", {
        input_tokens: 10,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 188_000,
        output_tokens: 999,
      }),
      { type: "user", message: { role: "user", content: "next" } },
    ]);
    expect(readTranscriptRuntime(path)).toEqual({
      model: "claude-opus-5-5",
      contextUsed: 190_010,
      contextMax: 1_000_000,
    });
  });

  it("skips subagent, synthetic, usage-less and malformed lines", () => {
    const path = write([
      assistant("claude-opus-4-1", { input_tokens: 500 }),
      assistant("claude-opus-4-1", { input_tokens: 90_000 }, { isSidechain: true }),
      assistant("<synthetic>", { input_tokens: 0 }),
      assistant("claude-opus-4-1", null),
      "{not json",
      "",
    ]);
    expect(readTranscriptRuntime(path)).toEqual({
      model: "claude-opus-4-1",
      contextUsed: 500,
      contextMax: null,
    });
  });

  it("reads only the tail and drops the cut first line", () => {
    const filler = { type: "user", message: { role: "user", content: "x".repeat(200) } };
    const lines: object[] = [assistant("claude-opus-5-5", { input_tokens: 7 })];
    for (let i = 0; i < 50; i++) lines.push(filler);
    const path = write(lines);
    // The only assistant line is far outside a 2 KB tail.
    expect(readTranscriptRuntime(path, 2048)).toBeNull();
    // A tail that starts inside the (only) assistant line must not parse the fragment.
    const path2 = write([
      assistant("claude-opus-5-5", { input_tokens: 7 }, { pad: "y".repeat(500) }),
    ]);
    expect(readTranscriptRuntime(path2, 300)).toBeNull();
    expect(readTranscriptRuntime(path2)?.contextUsed).toBe(7);
  });

  it("returns null for a missing file, an empty file and a directory", () => {
    expect(readTranscriptRuntime(join(dir, "nope.jsonl"))).toBeNull();
    expect(readTranscriptRuntime(write([]))).toBeNull();
    expect(readTranscriptRuntime(dir)).toBeNull();
  });
});
