import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type StartServerOptions, startServer } from "./index.js";
import { lastAssistantText } from "./providers/t3/replies.js";
import { parseSummary, summaryEnv, summaryPrompt } from "./summaries.js";
import { T3Fixture } from "./test-t3.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;
const owner: Actor = { kind: "owner" };

let dir: string;
let dbPath: string;
let cli: Axiom; // a second connection, standing in for the hook / CLI
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-desk-"));
  dbPath = join(dir, "axiom.db");
  cli = openDatabase(dbPath);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  cli.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake binary: a shell script. `body` runs with $DIR = the fake's own folder. */
function fake(name: string, body: string): string {
  const folder = join(dir, `fake-${name}`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, `#!/bin/sh\nDIR="${folder}"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const calls = (path: string): number => {
  const f = join(path, "..", "calls");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0;
};
const GOOD = `{"now":"It fixed the bug.","next":"Review the diff."}`;
/** A fake `claude` that records what it was given and prints `out`. */
const claudeSaying = (out: string, extra = "") =>
  fake(
    "claude",
    `echo run >> "$DIR/calls"; echo "$@" > "$DIR/args"; pwd > "$DIR/cwd"; env > "$DIR/env"
cat > "$DIR/stdin"; ${extra}
cat <<'EOF_OUT'
${out}
EOF_OUT`,
  );

async function start(opts: StartServerOptions = {}) {
  server = await startServer({
    dbPath,
    port: 0,
    webDist: join(dir, "no-web"),
    t3Dir: join(dir, "no-t3"),
    claudeCli: "/nonexistent/claude",
    t3Cli: "/nonexistent/t3",
    ...opts,
  });
}
async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch((server as RunningServer).url + path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as Any };
}
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function thread(slug = "demo", id = "s1", provider: "claude-code" | "t3" = "claude-code") {
  if (!cli.listTopics().some((t) => t.slug === slug)) {
    cli.createTopic({ slug, title: `Title ${slug}` }, owner);
  }
  return cli.attachThread(slug, { provider, providerThreadId: id }, owner);
}
const state = (id: number) => cli.getThread(id);

describe("summary worker", () => {
  it("summarises a new reply with Haiku in a clean environment and stores it on the thread only", async () => {
    process.env.CLAUDECODE = "1";
    process.env.T3CODE_THREAD_ID = "x";
    process.env.CLAUDE_CODE_SESSION_ID = "y";
    const claude = claudeSaying(`Sure, here it is:\n\`\`\`json\n${GOOD}\n\`\`\``);
    const th = thread();
    cli.setThreadReply(th.id, "I fixed the bug in parser.ts. Please review.");
    try {
      await start({ claudeCli: claude });
      await until(() => state(th.id).summaryNow !== null);
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.T3CODE_THREAD_ID;
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(state(th.id)).toMatchObject({
      summaryNow: "It fixed the bug.",
      summaryNext: "Review the diff.",
      summaryError: null,
      summaryReplyAt: state(th.id).lastReplyAt,
    });
    const dirOf = (f: string) => join(claude, "..", f);
    expect(readFileSync(dirOf("args"), "utf8").trim()).toBe(
      "-p --model haiku --no-session-persistence --output-format text",
    );
    const stdin = readFileSync(dirOf("stdin"), "utf8");
    expect(stdin).toContain("I fixed the bug in parser.ts. Please review.");
    expect(stdin).toContain('"now"');
    const env = readFileSync(dirOf("env"), "utf8");
    expect(env).toContain("AXIOM_INTERNAL=1");
    expect(env).not.toMatch(/^CLAUDECODE=/m);
    expect(env).not.toMatch(/^T3CODE_/m);
    expect(env).not.toMatch(/^CLAUDE_CODE_/m);
    const cwd = readFileSync(dirOf("cwd"), "utf8").trim();
    expect(cwd).toContain("axiom-summary-");
    expect(existsSync(cwd)).toBe(false); // the temp folder is removed
    expect(cli.listEntries("demo").some((e) => (e.body ?? "").includes("fixed"))).toBe(false);
  });

  it("sends only the last ~12 000 characters of a long reply", async () => {
    const claude = claudeSaying(GOOD);
    const th = thread();
    cli.setThreadReply(th.id, `HEAD${"x".repeat(30_000)}TAIL`);
    await start({ claudeCli: claude });
    await until(() => state(th.id).summaryNow !== null);
    const stdin = readFileSync(join(claude, "..", "stdin"), "utf8");
    expect(stdin).toContain("TAIL");
    expect(stdin).not.toContain("HEAD");
    expect(stdin.length).toBeLessThan(13_500);
  });

  it("junk output is stored as an error, not retried before the wait, and retried once it passes", async () => {
    const claude = fake(
      "claude",
      `cat > /dev/null; echo run >> "$DIR/calls"
if [ "$(wc -l < "$DIR/calls")" -lt 2 ]; then echo "I cannot do that"; else echo '${GOOD}'; fi`,
    );
    const th = thread();
    cli.setThreadReply(th.id, "reply");
    await start({ claudeCli: claude, summaryRetryMs: 500 });
    await until(() => state(th.id).summaryError !== null);
    expect(state(th.id).summaryError).toMatch(/no JSON/);
    expect(state(th.id).summaryNow).toBeNull();
    await api("/api/topics/demo/open", { method: "POST", body: {} }); // a change event
    await sleep(150);
    expect(calls(claude)).toBe(1); // too soon
    await until(() => state(th.id).summaryNow !== null, 6000); // the retry timer fires
    expect(calls(claude)).toBe(2);
    expect(state(th.id).summaryError).toBeNull();
  });

  it("a new reply is summarised again at once, even right after a failure", async () => {
    const claude = claudeSaying("nope");
    const th = thread();
    cli.setThreadReply(th.id, "one");
    await start({ claudeCli: claude });
    await until(() => state(th.id).summaryError !== null);
    cli.setThreadReply(th.id, "two");
    await until(() => calls(claude) >= 2);
  });

  it("kills a run that exceeds the timeout and stores an error", async () => {
    const claude = fake("claude", `cat > /dev/null; echo run >> "$DIR/calls"; exec sleep 30`);
    const th = thread();
    cli.setThreadReply(th.id, "reply");
    await start({ claudeCli: claude, summaryTimeoutMs: 300 });
    await until(() => state(th.id).summaryError !== null);
    expect(state(th.id).summaryError).toMatch(/timed out/);
    expect(state(th.id).summaryNow).toBeNull();
  });

  it("GET /api/desk carries the activity line, or null, and keeps it after the thread stops", async () => {
    const a = thread("a", "s1");
    const b = thread("b", "s2");
    cli.setThreadActivity(a.id, "$ npm test", "2026-11-25T10:00:00.000Z");
    await start({ claudeCli: claudeSaying(GOOD) });
    const find = (body: Any, slug: string) =>
      body.topics.find((t: Any) => t.slug === slug).threads[0];
    let body = (await api("/api/desk")).body;
    expect(find(body, "a").activity).toEqual({
      text: "$ npm test",
      at: "2026-11-25T10:00:00.000Z",
    });
    expect(find(body, "b").activity).toBeNull();
    expect(b.id).not.toBe(a.id);
    cli.threadWorking(a.id);
    cli.threadStopped(a.id);
    body = (await api("/api/desk")).body;
    expect(find(body, "a").activity?.text).toBe("$ npm test");
  });

  it("GET /api/desk carries the runtime (model, effort, context) or null, and a lean artifact list", async () => {
    const a = thread("a", "s1");
    thread("b", "s2");
    cli.setThreadRuntime(
      a.id,
      {
        model: "claude-opus-5-5",
        effort: "high",
        contextUsed: 190_000,
        contextMax: 1_000_000,
      },
      "2026-11-25T10:00:00.000Z",
    );
    cli.addLink("a", { kind: "repository", target: "/tmp/r" }, owner);
    cli.addLink(
      "a",
      { kind: "artifact", target: "/tmp/r/out.html", label: "Out", description: "The page" },
      owner,
    );
    await start({ claudeCli: claudeSaying(GOOD) });
    const { body } = await api("/api/desk");
    const first = (slug: string) => body.topics.find((t: Any) => t.slug === slug);
    expect(first("a").threads[0].runtime).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      contextUsed: 190_000,
      contextMax: 1_000_000,
      at: "2026-11-25T10:00:00.000Z",
    });
    expect(first("b").threads[0].runtime).toBeNull();
    expect(first("a").linkCount).toBe(2);
    expect(first("a").artifacts).toEqual([
      {
        id: expect.any(Number),
        kind: "artifact",
        target: "/tmp/r/out.html",
        label: "Out",
        description: "The page",
      },
    ]);
    expect(first("b").artifacts).toEqual([]);
  });

  it("GET /api/desk lists a thread's running subagents, none for an ended thread", async () => {
    const a = thread("a", "s1");
    const b = thread("b", "s2");
    cli.subagentStarted(a.id, "x1", "Explore");
    cli.setSubagents(a.id, [
      {
        key: "t3-1",
        title: "Review",
        agentType: null,
        model: "claude-haiku-5",
        progress: "Reading",
        startedAt: "2026-11-25T10:00:00.000Z",
      },
    ]);
    await start({ claudeCli: claudeSaying(GOOD) });
    const find = (body: Any, slug: string) => body.topics.find((t: Any) => t.slug === slug);
    let body = (await api("/api/desk")).body;
    // setSubagents made the list exactly the T3 one.
    expect(find(body, "a").threads[0].subagents).toEqual([
      {
        id: expect.any(Number),
        title: "Review",
        agentType: null,
        model: "claude-haiku-5",
        progress: "Reading",
        startedAt: "2026-11-25T10:00:00.000Z",
      },
    ]);
    expect(find(body, "b").threads[0].subagents).toEqual([]);
    cli.subagentStarted(b.id, "y1", "Explore");
    body = (await api("/api/desk")).body;
    expect(find(body, "b").threads[0].subagents).toMatchObject([
      { title: null, agentType: "Explore" },
    ]);
  });

  it("a missing binary is an error on the thread, not a crash", async () => {
    const th = thread();
    cli.setThreadReply(th.id, "reply");
    await start({ claudeCli: join(dir, "does-not-exist") });
    await until(() => state(th.id).summaryError !== null);
    expect(state(th.id).summaryError).toMatch(/cannot run/);
    expect((await api("/api/desk")).status).toBe(200);
  });

  it("runs one claude at a time", async () => {
    const claude = fake(
      "claude",
      `cat > /dev/null; echo run >> "$DIR/calls"
if [ -e "$DIR/lock" ]; then echo overlap >> "$DIR/overlap"; fi
touch "$DIR/lock"; sleep 0.3; rm "$DIR/lock"; echo '${GOOD}'`,
    );
    const a = thread("a", "sa");
    const b = thread("b", "sb");
    cli.setThreadReply(a.id, "A");
    cli.setThreadReply(b.id, "B");
    await start({ claudeCli: claude });
    await until(() => state(a.id).summaryNow !== null && state(b.id).summaryNow !== null, 8000);
    expect(existsSync(join(claude, "..", "overlap"))).toBe(false);
    expect(calls(claude)).toBe(2);
  });

  it("does nothing while the `summaries` setting is off, and works once it is turned on", async () => {
    const claude = claudeSaying(GOOD);
    cli.setSetting("summaries", { enabled: false }, owner);
    const th = thread();
    cli.setThreadReply(th.id, "reply");
    await start({ claudeCli: claude });
    await sleep(300);
    expect(calls(claude)).toBe(0);
    expect((await api("/api/settings")).body.summaries).toEqual({ enabled: false });
    await api("/api/settings", { method: "PUT", body: { summaries: { enabled: true } } });
    await until(() => state(th.id).summaryNow !== null);
    expect(calls(claude)).toBe(1);
  });

  it("uses the `claudeCli` setting over the default binary", async () => {
    const claude = claudeSaying(GOOD);
    cli.setSetting("claudeCli", claude, owner);
    const th = thread();
    cli.setThreadReply(th.id, "reply");
    await start({ claudeCli: "/nonexistent/claude" });
    await until(() => state(th.id).summaryNow !== null);
  });

  it("emits a change event after storing", async () => {
    const claude = claudeSaying(GOOD);
    const th = thread();
    cli.setThreadReply(th.id, "reply");
    await start({ claudeCli: claude });
    const events: string[] = [];
    const res = await fetch(`${(server as RunningServer).url}/api/events`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(dec.decode(value));
      }
    })();
    await until(() => state(th.id).summaryNow !== null);
    await until(() => events.join("").includes("event: change"));
    await reader.cancel();
    await pump.catch(() => {});
  });
});

describe("summary helpers", () => {
  it("parses tolerantly and rejects bad output", () => {
    expect(parseSummary(`ok {"now":"A","next":"B"} bye`)).toEqual({ now: "A", next: "B" });
    expect(parseSummary(`{"now":"A"}`)).toEqual({ now: "A", next: "Nothing" });
    expect(() => parseSummary("nothing")).toThrow(/no JSON/);
    expect(() => parseSummary("{oops}")).toThrow(/not valid JSON/);
    expect(() => parseSummary(`{"next":"x"}`)).toThrow(/"now"/);
  });
  it("strips session variables from the environment and marks it internal", () => {
    const env = summaryEnv({ PATH: "/bin", CLAUDECODE: "1", T3CODE_X: "1", CLAUDE_CODE_Y: "1" });
    expect(env).toEqual({ PATH: "/bin", AXIOM_INTERNAL: "1" });
  });
  it("the prompt carries the reply between markers", () => {
    expect(summaryPrompt("hello")).toContain("<<<REPLY\nhello\nREPLY>>>");
  });
});

describe("T3 reply fetch", () => {
  let t3: T3Fixture;
  beforeEach(() => {
    t3 = new T3Fixture(join(dir, "t3"));
  });
  afterEach(() => t3.close());

  const t3Saying = (json: string, exit = 0) =>
    fake(
      "t3",
      `echo run >> "$DIR/calls"; echo "$@" >> "$DIR/args"
cat <<'EOF_OUT'
${json}
EOF_OUT
exit ${exit}`,
    );
  const messages = JSON.stringify({
    messages: [
      { role: "user", text: "do it" },
      { role: "assistant", text: "Done: the T3 reply." },
    ],
  });

  it("fetches the latest assistant message when a T3 thread stops, once", async () => {
    t3.thread("a").run("a", 1, "running");
    const th = thread("demo", "a", "t3");
    const t3cli = t3Saying(messages);
    await start({ t3Dir: t3.dir, t3Cli: t3cli, t3PollMs: 60_000 });
    expect(cli.getTopic("demo").status).toBe("wip");
    expect(state(th.id).lastReply).toBeNull(); // still running: nothing to fetch
    t3.run("a", 1, "completed");
    cli.requestProviderRefresh("t3");
    await until(() => state(th.id).lastReply !== null);
    expect(state(th.id).lastReply).toBe("Done: the T3 reply.");
    expect(readFileSync(join(t3cli, "..", "args"), "utf8").trim()).toBe(
      "thread show a --messages 1 --json",
    );
    cli.requestProviderRefresh("t3");
    await sleep(300);
    expect(calls(t3cli)).toBe(1);
  });

  it("picks up the reply of a thread that stopped before the server started, and it gets summarised", async () => {
    t3.thread("a").run("a", 1, "running");
    const th = thread("demo", "a", "t3");
    cli.threadWorking(th.id); // Axiom saw it running ...
    t3.run("a", 1, "completed"); // ... and it stopped while the server was down
    const claude = claudeSaying(GOOD);
    await start({ t3Dir: t3.dir, t3Cli: t3Saying(messages), claudeCli: claude });
    await until(() => state(th.id).summaryNow !== null);
    expect(state(th.id).lastReply).toBe("Done: the T3 reply.");
  });

  it("a failing t3 binary leaves the thread alone and the server up", async () => {
    t3.thread("a").run("a", 1, "running");
    const th = thread("demo", "a", "t3");
    cli.threadWorking(th.id);
    t3.run("a", 1, "completed");
    const t3cli = t3Saying("boom", 1);
    await start({ t3Dir: t3.dir, t3Cli: t3cli });
    await until(() => calls(t3cli) >= 1);
    await sleep(100);
    expect(state(th.id).lastReply).toBeNull();
    expect((await api("/api/desk")).status).toBe(200);
  });

  it("uses the `t3Cli` setting over the default", async () => {
    t3.thread("a").run("a", 1, "running");
    const th = thread("demo", "a", "t3");
    cli.threadWorking(th.id);
    t3.run("a", 1, "completed");
    cli.setSetting("t3Cli", t3Saying(messages), owner);
    await start({ t3Dir: t3.dir });
    await until(() => state(th.id).lastReply !== null);
  });

  it("reads the last assistant message of the JSON", () => {
    expect(lastAssistantText(messages)).toBe("Done: the T3 reply.");
    expect(
      lastAssistantText(JSON.stringify({ messages: [{ role: "user", text: "x" }] })),
    ).toBeNull();
    expect(lastAssistantText(JSON.stringify({ thread: { messages: [] } }))).toBeNull();
    expect(() => lastAssistantText("not json")).toThrow();
  });
});

describe("Desk API", () => {
  it("lists open topics and favourites with their threads, summaries and flags", async () => {
    const a = thread("a", "sa");
    thread("b", "sb");
    cli.createTopic({ slug: "closed", title: "Closed" }, owner);
    cli.setTopicStatus("closed", "done", owner);
    cli.createTopic({ slug: "closed-fav", title: "Closed favourite" }, owner);
    cli.setTopicStatus("closed-fav", "done", owner);
    cli.setTopicFavorite("closed-fav", true, owner);
    cli.setTopicDeskHidden("b", true, owner);
    cli.setThreadReply(a.id, "reply text", "2026-11-25T10:00:00.000Z");
    cli.setThreadSummary(a.id, { now: "N", next: "X" }, "2026-11-25T10:00:00.000Z");
    cli.createTask("a", { key: "t1", title: "Task" }, owner);
    cli.addLink("a", { kind: "repository", target: "/tmp/r" }, owner);
    await start({ claudeCli: claudeSaying(GOOD) });
    const { status, body } = await api("/api/desk");
    expect(status).toBe(200);
    expect(body.topics.map((t: Any) => t.slug).sort()).toEqual(["a", "b", "closed-fav"]);
    const ta = body.topics.find((t: Any) => t.slug === "a");
    expect(ta).toMatchObject({
      title: "Title a",
      status: "idle",
      statusNote: null,
      favorite: false,
      deskHidden: false,
      deskOrder: null,
      taskCounts: { total: 1, done: 0 },
      linkCount: 1,
      highlighted: false,
      attention: null,
    });
    expect(typeof ta.lastWorkedAt).toBe("string");
    expect(ta.threads).toHaveLength(1);
    expect(ta.threads[0]).toMatchObject({
      id: a.id,
      provider: "claude-code",
      providerThreadId: "sa",
      title: null,
      status: "idle",
      open: true,
      endedAt: null,
      lastReplyAt: "2026-11-25T10:00:00.000Z",
      summary: { now: "N", next: "X" },
      summaryError: null,
      hasReply: true,
    });
    expect(typeof ta.threads[0].summary.at).toBe("string");
    expect(ta.threads[0]).not.toHaveProperty("lastReply");
    const tb = body.topics.find((t: Any) => t.slug === "b");
    expect(tb.deskHidden).toBe(true);
    expect(tb.threads[0]).toMatchObject({ summary: null, hasReply: false, lastReplyAt: null });
    expect(body.topics.find((t: Any) => t.slug === "closed-fav").favorite).toBe(true);
  });

  it("serves the full reply lazily, and 404s without one", async () => {
    const th = thread();
    await start();
    expect((await api(`/api/threads/${th.id}/reply`)).status).toBe(404);
    expect((await api("/api/threads/999/reply")).status).toBe(404);
    expect((await api("/api/threads/abc/reply")).status).toBe(400);
    cli.setThreadReply(th.id, "# Full\n\nreply", "2026-11-25T10:00:00.000Z");
    expect(await api(`/api/threads/${th.id}/reply`)).toEqual({
      status: 200,
      body: { text: "# Full\n\nreply", at: "2026-11-25T10:00:00.000Z" },
    });
    // The topic detail does not carry the full text.
    const detail = (await api("/api/topics/demo")).body;
    expect(detail.threads[0]).toMatchObject({ hasReply: true });
    expect(detail.threads[0]).not.toHaveProperty("lastReply");
  });

  it("favourite, hide and reorder work for the owner and validate input", async () => {
    thread("a", "sa");
    thread("b", "sb");
    thread("c", "sc");
    await start();
    expect(await api("/api/topics/a/favorite", { method: "POST", body: { on: true } })).toEqual({
      status: 200,
      body: { slug: "a", favorite: true },
    });
    expect(cli.getTopic("a").favorite).toBe(true);
    await api("/api/topics/a/favorite", { method: "POST", body: { on: false } });
    expect(cli.getTopic("a").favorite).toBe(false);
    expect(
      (await api("/api/topics/b/desk-hidden", { method: "POST", body: { hidden: true } })).body,
    ).toEqual({ slug: "b", deskHidden: true });
    expect(cli.getTopic("b").deskHidden).toBe(true);
    expect(
      (await api("/api/topics/nope/favorite", { method: "POST", body: { on: true } })).status,
    ).toBe(404);
    expect(
      (await api("/api/topics/a/favorite", { method: "POST", body: { on: "yes" } })).status,
    ).toBe(400);
    expect((await api("/api/topics/a/desk-hidden", { method: "POST", body: {} })).status).toBe(400);

    expect(
      (await api("/api/desk/order", { method: "PUT", body: { slugs: ["c", "a", "b"] } })).status,
    ).toBe(200);
    const order = (await api("/api/desk")).body.topics.map((t: Any) => [t.slug, t.deskOrder]);
    expect(Object.fromEntries(order)).toEqual({ c: 0, a: 1, b: 2 });
    expect(
      (await api("/api/desk/order", { method: "PUT", body: { slugs: ["a", "zzz"] } })).status,
    ).toBe(404);
    expect((await api("/api/desk/order", { method: "PUT", body: { slugs: "a" } })).status).toBe(
      400,
    );
    expect(
      (await api("/api/desk/order", { method: "PUT", body: { slugs: ["a", "a"] } })).status,
    ).toBe(400);
  });
});

it("leaves no temp folders behind", async () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("axiom-summary-")).length;
  const th = thread();
  cli.setThreadReply(th.id, "reply");
  await start({ claudeCli: claudeSaying(GOOD) });
  await until(() => state(th.id).summaryNow !== null);
  expect(readdirSync(tmpdir()).filter((n) => n.startsWith("axiom-summary-")).length).toBe(before);
});

describe("reply images", () => {
  it("serves an image only when its absolute path is in the thread's latest reply", async () => {
    const { readReplyImage } = await import("./docs.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "axiom-replyimg-"));
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const other = join(dir, "other.png");
    writeFileSync(other, Buffer.from([0x89]));
    const reply = `Here it is: ![s](${png})`;
    const ok = await readReplyImage(reply, png);
    expect(ok.type).toBe("image/png");
    await expect(readReplyImage(reply, other)).rejects.toMatchObject({ status: 403 });
    await expect(readReplyImage(reply, "shot.png")).rejects.toMatchObject({ status: 400 });
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "x");
    await expect(readReplyImage(`see ${txt}`, txt)).rejects.toMatchObject({ status: 403 });
    await expect(readReplyImage(null, png)).rejects.toMatchObject({ status: 404 });
  });
});
