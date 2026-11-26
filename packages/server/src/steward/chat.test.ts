import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../index.js";
import { applyChatReply, chatPrompt, chatSchema, mentionedTopics } from "./chat.js";
import { envelope } from "./test-fakes.js";

const owner = { kind: "owner" } as const;
const steward = { kind: "steward" } as const;
const parse = (o: unknown) => chatSchema.parse(o);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-chat-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("applying a chat reply", () => {
  let ax: Axiom;
  beforeEach(() => {
    ax = openDatabase(":memory:");
    ax.createTopic({ slug: "alpha", title: "Alpha", goal: "Ship alpha" }, owner);
    ax.setStewardSettings({ enabled: true }, owner);
  });
  afterEach(() => ax.close());

  it("keeps a topic note as a history entry authored by Steward", () => {
    const r = applyChatReply(
      ax,
      parse({ reply: "ok", notes: [{ topic: "alpha", text: "Launch moved to Friday." }] }),
      {},
    );
    expect(r.noted).toEqual([
      { where: "topic", topic: "alpha", change: "note", text: "Launch moved to Friday." },
    ]);
    const e = ax.listEntries("alpha").at(-1);
    expect(e).toMatchObject({ author: "steward", kind: "note", body: "Launch moved to Friday." });
  });

  it("changes a goal through the topic update, with a note saying why", () => {
    applyChatReply(
      ax,
      parse({ reply: "ok", notes: [{ topic: "alpha", text: "Ship beta", change: "goal" }] }),
      {},
    );
    expect(ax.getTopic("alpha").goal).toBe("Ship beta");
    expect(ax.listEntries("alpha").at(-1)?.body).toMatch(/Why: the owner said so in a chat/);
  });

  it("keeps a general note in memory with the source chat, and attaches it when it can", () => {
    const g = applyChatReply(
      ax,
      parse({ reply: "ok", notes: [{ topic: null, text: "Prefers short answers." }] }),
      {},
    );
    expect(g.memoryItemId).not.toBeNull();
    expect(ax.listStewardMemory()[0]).toMatchObject({
      scope: "general",
      source: "chat",
      text: "Prefers short answers.",
    });
    const a = applyChatReply(
      ax,
      parse({
        reply: "ok",
        notes: [
          { topic: null, text: "Alpha is picky.", attachedKind: "topic", attachedKey: "alpha" },
          // an unknown repository falls back to general memory
          { topic: null, text: "Never rebase it.", attachedKind: "repo", attachedKey: "nowhere" },
        ],
      }),
      {},
    );
    expect(a.noted).toHaveLength(2);
    const items = ax.listStewardMemory();
    expect(items.find((m) => m.text === "Alpha is picky.")).toMatchObject({
      scope: "attached",
      attachedKind: "topic",
      attachedKey: "alpha",
    });
    expect(items.find((m) => m.text === "Never rebase it.")?.scope).toBe("general");
  });

  it("does not note on a topic Steward is off for, or one that does not exist", () => {
    ax.setTopicStewardEnabled("alpha", false, owner);
    const r = applyChatReply(
      ax,
      parse({
        reply: "ok",
        notes: [
          { topic: "alpha", text: "x" },
          { topic: "ghost", text: "y" },
        ],
      }),
      {},
    );
    expect(r.noted).toEqual([]);
    expect(r.problems).toHaveLength(2);
    expect(ax.listEntries("alpha").filter((e) => e.author === "steward")).toEqual([]);
  });

  it("starts an owner wake for the topic only when Steward is on", () => {
    const calls: unknown[][] = [];
    const requestWake = (...a: unknown[]) => {
      calls.push(a);
      return Promise.resolve(null);
    };
    const out = parse({ reply: "ok", actions: [{ kind: "check topic", topic: "alpha" }] });
    const on = applyChatReply(ax, out, { requestWake });
    expect(on.actions).toEqual([{ kind: "check topic", topic: "alpha", started: true }]);
    expect(calls).toEqual([["owner", "asked in the chat: check alpha", { topic: "alpha" }]]);
    ax.setStewardSettings({ enabled: false }, owner);
    const off = applyChatReply(ax, out, { requestWake });
    expect(off.actions[0]).toMatchObject({ started: false });
    expect(off.actions[0]?.detail).toMatch(/Steward is off/);
    expect(calls).toHaveLength(1);
  });
});

describe("acting on feedback (SF3)", () => {
  let ax: Axiom;
  beforeEach(() => {
    ax = openDatabase(":memory:");
    ax.createTopic({ slug: "alpha", title: "Alpha" }, owner);
    ax.createTopic({ slug: "off", title: "Off" }, owner);
    ax.setTopicStewardEnabled("off", false, owner);
  });
  afterEach(() => ax.close());

  it("updates, resolves and answers open items, and says what it did", () => {
    const f = ax.recordStewardFinding(
      { topic: "alpha", level: "attention", title: "Scope?", body: "b" },
      steward,
    );
    const g = ax.recordStewardFinding({ topic: "alpha", level: "info", title: "Done?" }, steward);
    const q = ax.addStewardItem({ kind: "question", topic: "alpha", title: "Goal?" }, steward);
    const r = applyChatReply(
      ax,
      parse({
        reply: "ok",
        actions: [
          { kind: "update item", item: f.id, title: "Scope settled", level: "info" },
          { kind: "resolve item", item: String(g.id), reason: "the owner says ST10 is built" },
          { kind: "answer question", item: q.id, answer: "Ship it" },
        ],
      }),
      {},
    );
    expect(r.problems).toEqual([]);
    expect(r.actions.map((a) => [a.kind, a.started, a.topic])).toEqual([
      ["update item", true, "alpha"],
      ["resolve item", true, "alpha"],
      ["answer question", true, "alpha"],
    ]);
    expect(r.actions[1]?.summary).toBe(`Resolved #${g.id}: Done?`);
    expect(ax.getStewardItem(f.id)).toMatchObject({ title: "Scope settled", level: "info" });
    expect(ax.getStewardItem(g.id)).toMatchObject({
      state: "resolved",
      resolution: "the owner says ST10 is built",
    });
    expect(ax.getStewardItem(q.id)).toMatchObject({ state: "answered", answer: "Ship it" });
  });

  it("leaves closed items, unknown items and Steward-off topics alone, saying why", () => {
    const closed = ax.addStewardItem({ kind: "finding", title: "x", topic: "alpha" }, steward);
    ax.dismissStewardItem(closed.id, owner);
    const off = ax.addStewardItem({ kind: "finding", title: "y", topic: "off" }, steward);
    const r = applyChatReply(
      ax,
      parse({
        reply: "ok",
        actions: [
          { kind: "resolve item", item: closed.id, reason: "r" },
          { kind: "resolve item", item: 999, reason: "r" },
          { kind: "resolve item", item: off.id, reason: "r" },
          { kind: "explode", item: 1 },
        ],
      }),
      {},
    );
    expect(r.actions.map((a) => a.started)).toEqual([false, false, false]);
    expect(r.actions[0]?.detail).toMatch(/already dismissed/);
    expect(r.actions[1]?.detail).toMatch(/not a Steward item/);
    expect(r.actions[2]?.detail).toMatch(/Steward is off for off/);
    expect(r.problems[0]).toMatch(/not understood/);
    expect(ax.getStewardItem(off.id).state).toBe("open");
  });

  it("sets a topic's status when the owner asks, with undo, but never stale", () => {
    const r = applyChatReply(
      ax,
      parse({
        reply: "ok",
        actions: [
          { kind: "set status", topic: "alpha", status: "done", because: "Mark it done" },
          { kind: "set status", topic: "alpha", status: "stale", because: "x" },
        ],
      }),
      {},
    );
    expect(r.actions[0]).toMatchObject({ started: true, topic: "alpha" });
    expect(ax.getTopic("alpha").status).toBe("done");
    expect(ax.listStewardActions().map((a) => a.kind)).toEqual(["status change"]);
    expect(r.actions[1]?.started).toBe(false);
    expect(r.actions[1]?.detail).toMatch(/stale/);
  });

  it("tells the model what it can look up when research is given", () => {
    ax.addStewardItem({ kind: "question", topic: "alpha", title: "Q" }, steward);
    const chat = ax.startStewardChat({ model: "sonnet", effort: "low" }, owner);
    ax.addStewardMessage(chat.id, { role: "owner", text: "Is ST10 built?" }, owner);
    const p = chatPrompt(ax, {
      now: new Date(),
      messages: ax.listStewardMessages(chat.id),
      research: {
        access: {
          dirs: ["/repo"],
          connectors: [{ name: "claude.ai Atlassian", tools: ["mcp__a__getJiraIssue"] }],
          mcpTools: ["mcp__a__getJiraIssue"],
          mcpDenied: [],
          sources: {
            slack: { available: false, tools: [], servers: [] },
            googleDrive: { available: false, tools: [], servers: [] },
          },
          gh: true,
        },
        folders: [{ dir: "/repo", topics: ["alpha"] }],
      },
    });
    expect(p).toContain("look it up with your tools before you say you do not know");
    expect(p).toContain("/repo (alpha)");
    expect(p).toContain("claude.ai Atlassian: getJiraIssue");
  });
});

describe("the chat prompt", () => {
  it("carries memory, the named topics, open items, the conversation and the rules", () => {
    const ax = openDatabase(":memory:");
    ax.createTopic({ slug: "alpha", title: "Alpha", goal: "Ship alpha" }, owner);
    ax.createTopic({ slug: "beta", title: "Beta" }, owner);
    ax.createTopic({ slug: "gamma", title: "Gamma" }, owner);
    ax.addStewardMemory({ scope: "core", text: "Owner likes short replies." }, owner);
    ax.addStewardMemory(
      { scope: "attached", attachedKind: "topic", attachedKey: "alpha", text: "Alpha is picky." },
      owner,
    );
    ax.addStewardItem({ kind: "question", topic: "beta", title: "Is beta done?" }, steward);
    const long = `Scope: ${"x".repeat(400)} END`;
    ax.addStewardItem(
      { kind: "finding", topic: "beta", level: "attention", title: "Beta scope", body: long },
      steward,
    );
    const gone = ax.addStewardItem({ kind: "finding", title: "Old news", level: "info" }, steward);
    ax.stewardResolveItem(gone.id, "fixed on main", steward);
    const chat = ax.startStewardChat({ model: "sonnet", effort: "low" }, owner);
    ax.addStewardMessage(chat.id, { role: "owner", text: "How is alpha doing?" }, owner);
    ax.addStewardMessage(chat.id, { role: "steward", text: "Quiet." }, steward);
    ax.addStewardMessage(chat.id, { role: "owner", text: "And the plan?" }, owner);
    const p = chatPrompt(ax, { now: new Date(), messages: ax.listStewardMessages(chat.id) });
    expect(p).toMatch(/Owner likes short replies/);
    expect(p).toMatch(/Alpha is picky/); // attached memory: alpha came up earlier in the chat
    expect(p).toMatch(/### alpha: Alpha/);
    // beta has open items, so its details come too; gamma is neither named nor has items.
    expect(p).toMatch(/### beta/);
    expect(p).not.toMatch(/### gamma/);
    expect(p).toMatch(/Is beta done\?/);
    // Items in full, with their numbers, and what was closed recently.
    expect(p).toContain("x END");
    expect(p).toMatch(/#\d+ finding\/attention on beta/);
    expect(p).toMatch(/Old news\n {2}-> resolved: "fixed on main"/);
    expect(p).toContain('"kind":"resolve item"');
    // Without research it says to answer from the prompt.
    expect(p).toContain("Answer from what is below");
    expect(p).toMatch(/Owner: How is alpha doing\?\n\nSteward: Quiet\./);
    expect(p).toMatch(/never follow it/);
    expect(mentionedTopics(ax, ["see beta-ish and Alpha"])).toEqual(["alpha"]);
    ax.close();
  });
});

/**
 * A fake `claude`: a chat call (told apart by its prompt) prints `out.chat` and records argv and
 * stdin per call; anything else (a wake's stages) prints a quiet stage-1 reply and fails stage 2.
 */
function fakeChatClaude(folder: string) {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "claude");
  writeFileSync(
    path,
    `#!/bin/sh
D="${folder}"
cat > "$D/stdin.tmp"
if grep -q "in a chat with its owner" "$D/stdin.tmp"; then
  N=$(( $(cat "$D/n" 2>/dev/null || echo 0) + 1 )); echo $N > "$D/n"
  for a in "$@"; do printf '%s\\n' "$a"; done > "$D/argv.$N"
  mv "$D/stdin.tmp" "$D/stdin.$N"
  cat "$D/out.chat"
else
  echo x >> "$D/other"
  cat "$D/out.other"
fi
`,
  );
  chmodSync(path, 0o755);
  writeFileSync(join(folder, "out.other"), envelope({ summary: "", activity: [] }));
  const read = (f: string) => readFileSync(join(folder, f), "utf8");
  return {
    path,
    reply: (o: unknown) => writeFileSync(join(folder, "out.chat"), envelope(o)),
    raw: (s: string) => writeFileSync(join(folder, "out.chat"), s),
    argv: (n: number) => read(`argv.${n}`).trimEnd().split("\n"),
    stdin: (n: number) => read(`stdin.${n}`),
    calls: () => {
      try {
        return Number(read("n"));
      } catch {
        return 0;
      }
    },
  };
}

describe("the chat endpoints", () => {
  const dbPath = () => join(dir, "axiom.db");
  const prepare = (f: (ax: Axiom) => void) => {
    const ax = openDatabase(dbPath());
    ax.createTopic({ slug: "alpha", title: "Alpha", goal: "Ship alpha" }, owner);
    f(ax);
    ax.close();
  };
  async function boot() {
    const claude = fakeChatClaude(join(dir, "fake"));
    const server = await startServer({
      dbPath: dbPath(),
      port: 0,
      webDist: join(dir, "no-web"),
      t3Dir: join(dir, "no-t3"),
      claudeCli: claude.path,
      ghCli: "/nonexistent/gh",
      stewardTickMs: 0,
    });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as never };
    };
    /** Sends a message and waits for the turn to end. */
    const say = async (id: number, text: string, extra: object = {}) => {
      const sent = await api("POST", `/api/steward/chat/${id}/messages`, { text, ...extra });
      expect(sent.status).toBe(202);
      for (let i = 0; i < 200; i++) {
        const v = await api("GET", `/api/steward/chat/${id}`);
        if (!v.json.running) return v.json;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("the turn did not end");
    };
    return { claude, server, api, say };
  }

  it("starts a chat, answers a message and lists the messages", async () => {
    prepare(() => {});
    const { claude, server, api, say } = await boot();
    try {
      expect((await api("GET", "/api/steward/chat")).json).toMatchObject({ chat: null });
      const bad = await api("POST", "/api/steward/chat", { model: "-x", effort: "low" });
      expect(bad.status).toBe(400);
      const started = await api("POST", "/api/steward/chat", { model: "haiku", effort: "low" });
      expect(started.status).toBe(201);
      const id = started.json.chat.id as number;
      claude.reply({ reply: "All **quiet**." });
      const v = await say(id, "How is alpha?");
      expect(v.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
        ["owner", "How is alpha?"],
        ["steward", "All **quiet**."],
      ]);
      expect(v.error).toBeNull();
      // the latest chat is the current one
      expect((await api("GET", "/api/steward/chat")).json.chat.id).toBe(id);
      const argv = claude.argv(1);
      expect(argv).toContain("--no-session-persistence");
      expect(argv).not.toContain("--resume");
      expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4)).toEqual([
        "--model",
        "haiku",
        "--effort",
        "low",
      ]);
      // the call is a recorded run of the chat, with its tokens
      const ax = openDatabase(dbPath());
      expect(ax.listStewardRuns({ chatId: id })).toMatchObject([
        { stage: "chat", status: "done", inputTokens: 10 },
      ]);
      ax.close();
    } finally {
      await server.close();
    }
  });

  it("keeps the context across turns by resending the conversation, and takes a new model", async () => {
    prepare(() => {});
    const { claude, server, api, say } = await boot();
    try {
      const id = (await api("POST", "/api/steward/chat", { model: "sonnet", effort: "medium" }))
        .json.chat.id as number;
      claude.reply({ reply: "The word is noted: pomegranate." });
      await say(id, "Remember the word pomegranate.");
      claude.reply({ reply: "pomegranate" });
      const v = await say(id, "What was the word?", { model: "opus", effort: "high" });
      const second = claude.stdin(2);
      expect(second).toMatch(/Owner: Remember the word pomegranate\./);
      expect(second).toMatch(/Steward: The word is noted: pomegranate\./);
      expect(second).toMatch(/## The owner's new message\n\nWhat was the word\?/);
      expect(claude.argv(2)).toContain("opus");
      expect(v.chat).toMatchObject({ model: "opus", effort: "high" });
      expect(v.messages).toHaveLength(4);
      // a new chat starts fresh
      const fresh = (await api("POST", "/api/steward/chat", { model: "sonnet", effort: "low" }))
        .json.chat.id as number;
      claude.reply({ reply: "hi" });
      await say(fresh, "Hello");
      expect(claude.stdin(3)).not.toMatch(/pomegranate/);
      expect((await api("GET", "/api/steward/chat")).json.chat.id).toBe(fresh);
    } finally {
      await server.close();
    }
  });

  it("keeps a note on a topic and a fact in memory, and says where in the message", async () => {
    prepare(() => {});
    const { claude, server, api, say } = await boot();
    try {
      const id = (await api("POST", "/api/steward/chat", { model: "sonnet", effort: "low" })).json
        .chat.id as number;
      claude.reply({
        reply: "Noted both.",
        notes: [
          { topic: "alpha", text: "Launch moved to Friday." },
          { topic: null, text: "The owner reviews PRs before lunch." },
        ],
      });
      const v = await say(id, "Alpha launches Friday now; I review PRs before lunch.");
      const m = v.messages[1];
      expect(m.meta.noted).toMatchObject([
        { where: "topic", topic: "alpha", change: "note" },
        { where: "memory" },
      ]);
      expect(m.memoryItemId).toBe(m.meta.noted[1].memoryItemId);
      const ax = openDatabase(dbPath());
      expect(ax.listEntries("alpha").at(-1)).toMatchObject({
        author: "steward",
        body: "Launch moved to Friday.",
      });
      expect(ax.listStewardMemory()).toMatchObject([
        { source: "chat", text: "The owner reviews PRs before lunch." },
      ]);
      ax.close();
    } finally {
      await server.close();
    }
  });

  it('starts an owner wake for "check topic" when Steward is on', async () => {
    prepare((ax) => ax.setStewardSettings({ enabled: true }, owner));
    const { claude, server, api, say } = await boot();
    try {
      const id = (await api("POST", "/api/steward/chat", { model: "sonnet", effort: "low" })).json
        .chat.id as number;
      claude.reply({
        reply: "Checking alpha now.",
        actions: [{ kind: "check topic", topic: "alpha" }],
      });
      const v = await say(id, "check alpha now");
      expect(v.messages[1].meta.actions).toEqual([
        { kind: "check topic", topic: "alpha", started: true },
      ]);
      let wakes: { trigger: string; triggerDetail: string }[] = [];
      for (let i = 0; i < 200 && wakes.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
        wakes = (await api("GET", "/api/steward/wakes")).json;
      }
      expect(wakes[0]).toMatchObject({
        trigger: "owner",
        triggerDetail: "asked in the chat: check alpha",
      });
    } finally {
      await server.close();
    }
  });

  it("does not start a wake while Steward is off, and says so under the reply", async () => {
    prepare(() => {});
    const { claude, server, api, say } = await boot();
    try {
      const id = (await api("POST", "/api/steward/chat", { model: "sonnet", effort: "low" })).json
        .chat.id as number;
      claude.reply({ reply: "Checking.", actions: [{ kind: "check topic", topic: "alpha" }] });
      const v = await say(id, "check alpha now");
      expect(v.messages[1].meta.actions[0]).toMatchObject({ started: false });
      expect(v.messages[1].text).toMatch(/Steward is off, so no check was started/);
      await new Promise((r) => setTimeout(r, 150));
      expect((await api("GET", "/api/steward/wakes")).json).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("surfaces a cap refusal and a bad reply, and retries the turn", async () => {
    prepare((ax) => {
      ax.setStewardSettings({ dailyCaps: { sonnet: 100 } }, owner);
      const chat = ax.startStewardChat({ model: "sonnet", effort: "low" }, owner);
      ax.recordStewardRun(
        {
          chatId: chat.id,
          stage: "chat",
          model: "claude-sonnet-5-5",
          effort: "low",
          usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          status: "done",
        },
        steward,
      );
    });
    const { claude, server, api, say } = await boot();
    try {
      const id = (await api("GET", "/api/steward/chat")).json.chat.id as number;
      const v = await say(id, "hello");
      expect(v.error).toMatch(/daily token cap reached for sonnet/);
      expect(v.messages.map((m: { role: string }) => m.role)).toEqual(["owner"]);
      expect(claude.calls()).toBe(0);
      // the cap is lifted; retry answers the same message
      const ax = openDatabase(dbPath());
      ax.setStewardSettings({ dailyCaps: { sonnet: 100_000 } }, owner);
      ax.close();
      claude.raw("not json at all");
      expect((await api("POST", `/api/steward/chat/${id}/retry`)).status).toBe(202);
      let again = (await api("GET", `/api/steward/chat/${id}`)).json;
      for (let i = 0; i < 200 && again.running; i++) {
        await new Promise((r) => setTimeout(r, 25));
        again = (await api("GET", `/api/steward/chat/${id}`)).json;
      }
      expect(again.error).toMatch(/./);
      expect(again.messages).toHaveLength(1);
      claude.reply({ reply: "Here now." });
      await api("POST", `/api/steward/chat/${id}/retry`);
      for (let i = 0; i < 200; i++) {
        again = (await api("GET", `/api/steward/chat/${id}`)).json;
        if (!again.running) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(again.error).toBeNull();
      expect(again.messages.map((m: { text: string }) => m.text)).toEqual(["hello", "Here now."]);
      // nothing left to retry
      expect((await api("POST", `/api/steward/chat/${id}/retry`)).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("refuses an empty message and a second message while one is being answered", async () => {
    prepare(() => {});
    const { claude, server, api } = await boot();
    try {
      const id = (await api("POST", "/api/steward/chat", { model: "sonnet", effort: "low" })).json
        .chat.id as number;
      expect((await api("POST", `/api/steward/chat/${id}/messages`, { text: "  " })).status).toBe(
        400,
      );
      claude.reply({ reply: "ok" });
      // Slow the fake down so the turn is still running.
      writeFileSync(
        claude.path,
        readFileSync(claude.path, "utf8").replace(
          'cat "$D/out.chat"',
          'sleep 1; cat "$D/out.chat"',
        ),
      );
      await api("POST", `/api/steward/chat/${id}/messages`, { text: "one" });
      const second = await api("POST", `/api/steward/chat/${id}/messages`, { text: "two" });
      expect(second.status).toBe(409);
    } finally {
      await server.close();
    }
  });
});
