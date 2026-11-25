import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type StartServerOptions, startServer } from "./index.js";
import { agentEnv, parseStartedThreadId } from "./sending.js";
import { T3Fixture } from "./test-t3.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;
const owner: Actor = { kind: "owner" };

let dir: string;
let dbPath: string;
let cli: Axiom;
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-send-"));
  dbPath = join(dir, "axiom.db");
  cli = openDatabase(dbPath);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  cli.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake binary that records argv (one per line), stdin, cwd and env into its own folder. */
function fake(name: string, extra = "", out = "") {
  const folder = join(dir, `fake-${name}`);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(
    path,
    `#!/bin/sh
DIR="${folder}"
for a in "$@"; do printf '%s\\n' "$a"; done > "$DIR/argv"
pwd > "$DIR/cwd"; env > "$DIR/env"; cat > "$DIR/stdin"
${extra}
${out ? `echo '${out}'` : ""}
echo done > "$DIR/finished"
`,
  );
  chmodSync(path, 0o755);
  const read = (f: string) => readFileSync(join(folder, f), "utf8");
  return {
    path,
    argv: () => read("argv").trimEnd().split("\n"),
    stdin: () => read("stdin"),
    cwd: () => read("cwd").trim(),
    env: () => read("env"),
    ran: () => existsSync(join(folder, "finished")),
  };
}

async function start(opts: StartServerOptions = {}) {
  server = await startServer({
    dbPath,
    port: 0,
    webDist: join(dir, "no-web"),
    t3Dir: join(dir, "no-t3"),
    claudeCli: "/nonexistent/claude",
    t3Cli: "/nonexistent/t3",
    sendGraceMs: 3000,
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

function topic(slug = "demo") {
  cli.createTopic({ slug, title: `Title ${slug}` }, owner);
  return slug;
}
function thread(provider: "claude-code" | "t3", id: string, slug = "demo") {
  if (!cli.listTopics().some((t) => t.slug === slug)) topic(slug);
  return cli.attachThread(slug, { provider, providerThreadId: id }, owner);
}
const ownerInputs = (slug = "demo") =>
  cli.listEntries(slug).filter((e) => e.kind === "owner input");

describe("POST /api/threads/:id/send", () => {
  it("sends to a T3 thread with `t3 thread send <id> -` and the text on stdin", async () => {
    const t3 = fake("t3");
    const th = thread("t3", "th-77");
    await start({ t3Cli: t3.path });
    const r = await api(`/api/threads/${th.id}/send`, {
      method: "POST",
      body: { text: "Please continue\nnow" },
    });
    expect(r.status).toBe(200);
    expect(t3.argv()).toEqual(["thread", "send", "th-77", "-"]);
    expect(t3.stdin()).toBe("Please continue\nnow");
    const entries = ownerInputs();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ body: "Please continue\nnow", author: "owner" });
  });

  it("uses the t3Cli setting over the default", async () => {
    const t3 = fake("t3");
    const th = thread("t3", "th-1");
    cli.setSetting("t3Cli", t3.path, owner);
    await start();
    expect(
      (await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "x" } })).status,
    ).toBe(200);
    expect(t3.argv()).toEqual(["thread", "send", "th-1", "-"]);
  });

  it("refuses a model or effort for an existing T3 thread with 400", async () => {
    const t3 = fake("t3");
    const th = thread("t3", "th-1");
    await start({ t3Cli: t3.path });
    const r = await api(`/api/threads/${th.id}/send`, {
      method: "POST",
      body: { text: "x", model: "claude-opus-5-5" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/cannot change the model or effort/);
    expect(t3.ran()).toBe(false);
    expect(ownerInputs()).toHaveLength(0);
    expect(cli.getThread(th.id).model).toBeNull();
  });

  it("maps a failing binary to 502 with trimmed stderr and writes no history", async () => {
    const t3 = fake("t3", "echo '  boom: no server  ' >&2; exit 3");
    const th = thread("t3", "th-1");
    await start({ t3Cli: t3.path });
    const r = await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "x" } });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("provider");
    expect(r.body.error.message).toContain("boom: no server");
    expect(r.body.error.message).not.toContain("  boom");
    expect(ownerInputs()).toHaveLength(0);
  });

  it("maps a missing binary to 502", async () => {
    const th = thread("t3", "th-1");
    await start();
    const r = await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "x" } });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toMatch(/cannot run/);
  });

  it("rejects empty text and unknown fields", async () => {
    const th = thread("t3", "th-1");
    await start();
    expect(
      (await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "  " } })).status,
    ).toBe(400);
    expect(
      (await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "x", bogus: 1 } }))
        .status,
    ).toBe(400);
    expect(
      (await api("/api/threads/999/send", { method: "POST", body: { text: "x" } })).status,
    ).toBe(404);
  });

  it("resumes an ended Claude Code session in its cwd, reopens it and keeps hooks on", async () => {
    process.env.CLAUDECODE = "1";
    process.env.T3CODE_THREAD_ID = "x";
    process.env.CLAUDE_CODE_SESSION_ID = "y";
    process.env.AXIOM_INTERNAL = "1";
    const claude = fake("claude");
    const work = join(dir, "work");
    mkdirSync(work);
    const th = thread("claude-code", "sess-1");
    cli.setThreadCwd(th.id, work);
    cli.threadEnded(th.id, "other");
    try {
      await start({ claudeCli: claude.path });
      const r = await api(`/api/threads/${th.id}/send`, {
        method: "POST",
        body: { text: "Go on", model: "claude-sonnet-5-5", effort: "high" },
      });
      expect(r.status).toBe(200);
      await until(() => claude.ran());
    } finally {
      for (const k of [
        "CLAUDECODE",
        "T3CODE_THREAD_ID",
        "CLAUDE_CODE_SESSION_ID",
        "AXIOM_INTERNAL",
      ]) {
        delete process.env[k];
      }
    }
    expect(claude.argv()).toEqual([
      "-p",
      "--resume",
      "sess-1",
      "--allowedTools=Bash(axiom *)",
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "high",
    ]);
    expect(claude.stdin()).toBe("Go on");
    expect(readFileSync(join(claude.path, "..", "cwd"), "utf8").trim()).toBe(work);
    const env = claude.env();
    expect(env).not.toMatch(/^CLAUDECODE=/m);
    expect(env).not.toMatch(/^T3CODE_/m);
    expect(env).not.toMatch(/^CLAUDE_CODE_/m);
    expect(env).not.toMatch(/^AXIOM_INTERNAL=/m);
    expect(cli.getThread(th.id).endedAt).toBeNull();
    expect(ownerInputs()[0].body).toBe("Go on");
    // The chosen model and effort show on the card at once; the context is untouched.
    expect(cli.getThread(th.id)).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "high",
      contextUsed: null,
    });
  });

  it("omits model and effort flags when none are given", async () => {
    const claude = fake("claude");
    const th = thread("claude-code", "sess-2");
    cli.threadEnded(th.id, "other");
    await start({ claudeCli: claude.path });
    await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "hi" } });
    expect(claude.argv()).toEqual(["-p", "--resume", "sess-2", "--allowedTools=Bash(axiom *)"]);
    expect(cli.getThread(th.id)).toMatchObject({ model: null, effort: null, runtimeAt: null });
  });

  it("answers 409 with the resume command while the session is open, and runs nothing", async () => {
    const claude = fake("claude");
    const th = thread("claude-code", "sess-3");
    cli.setThreadCwd(th.id, "/home/me/it's here");
    await start({ claudeCli: claude.path });
    const r = await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "hi" } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: "conflict",
      message: "This session is open in a terminal; reply there or close it first.",
      resumeCommand: "cd '/home/me/it'\\''s here' && claude --resume sess-3",
    });
    expect(claude.ran()).toBe(false);
    expect(ownerInputs()).toHaveLength(0);
  });

  it("answers 502 when the detached claude fails early, but the history stays clean", async () => {
    const claude = fake("claude", "echo 'no such session' >&2; exit 1");
    const th = thread("claude-code", "sess-4");
    cli.threadEnded(th.id, "other");
    await start({ claudeCli: claude.path });
    const r = await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "hi" } });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain("no such session");
    expect(ownerInputs()).toHaveLength(0);
  });

  it("does not wait for a long run", async () => {
    const claude = fake("claude", "sleep 5");
    const th = thread("claude-code", "sess-5");
    cli.threadEnded(th.id, "other");
    await start({ claudeCli: claude.path, sendGraceMs: 200 });
    const t0 = Date.now();
    const r = await api(`/api/threads/${th.id}/send`, { method: "POST", body: { text: "hi" } });
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("POST /api/topics/:slug/threads/new", () => {
  it("starts a T3 thread in the topic's repository and attaches it", async () => {
    const t3 = fake("t3", "", '{"threadId":"new-9"}');
    topic();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const fixture = new T3Fixture(join(dir, "t3"));
    fixture.project("p1", { root: dir });
    fixture.close();
    cli.addLink("demo", { kind: "repository", target: repo }, owner);
    await start({ t3Cli: t3.path, t3Dir: join(dir, "t3") });
    const r = await api("/api/topics/demo/threads/new", {
      method: "POST",
      body: {
        text: "Build the thing\nwith care",
        provider: "t3",
        providerInstance: "claudeAgent",
        model: "claude-opus-5-5",
        effort: "max",
      },
    });
    expect(r.status).toBe(201);
    expect(t3.argv()).toEqual([
      "thread",
      "start",
      repo,
      "-",
      "--title",
      "Build the thing",
      "--provider",
      "claudeAgent",
      "--model",
      "claude-opus-5-5",
      "--option",
      "effort=max",
      "--json",
    ]);
    const sent = t3.stdin();
    expect(sent).toMatch(/^\[Axiom\] This thread is tracked in Axiom/);
    expect(sent).toContain("- Topic: `demo`");
    expect(sent.endsWith("Message from the owner:\n\nBuild the thing\nwith care")).toBe(true);
    expect(r.body).toMatchObject({
      provider: "t3",
      providerThreadId: "new-9",
      title: "Build the thing",
    });
    expect(cli.getTopic("demo").threads.map((t) => t.providerThreadId)).toEqual(["new-9"]);
    expect(cli.getTopic("demo").threads[0]).toMatchObject({
      model: "claude-opus-5-5",
      effort: "max",
    });
    expect(ownerInputs()[0].body).toBe("Build the thing\nwith care");
  });

  it("starts a T3 thread with only the defaults when no model is given", async () => {
    const t3 = fake("t3", "", '{"thread":{"id":"n-1"}}');
    topic();
    await start({ t3Cli: t3.path });
    const r = await api("/api/topics/demo/threads/new", {
      method: "POST",
      body: { text: "Hi", provider: "t3", project: "/p" },
    });
    expect(r.status).toBe(201);
    expect(t3.argv()).toEqual(["thread", "start", "/p", "-", "--title", "Hi", "--json"]);
    expect(r.body.providerThreadId).toBe("n-1");
  });

  it("400 for a T3 thread without a project or a repository link", async () => {
    const t3 = fake("t3", "", '{"threadId":"n"}');
    topic();
    await start({ t3Cli: t3.path });
    const r = await api("/api/topics/demo/threads/new", {
      method: "POST",
      body: { text: "Hi", provider: "t3" },
    });
    expect(r.status).toBe(400);
    expect(t3.ran()).toBe(false);
    expect(cli.getTopic("demo").threads).toHaveLength(0);
  });

  it("400 when the repository folder is missing or in no T3 project, and t3 never runs", async () => {
    const t3 = fake("t3", "", '{"threadId":"n"}');
    topic();
    const fixture = new T3Fixture(join(dir, "t3"));
    fixture.project("p1", { root: join(dir, "elsewhere") });
    fixture.close();
    await start({ t3Cli: t3.path, t3Dir: join(dir, "t3") });
    const post = () =>
      api("/api/topics/demo/threads/new", { method: "POST", body: { text: "Hi", provider: "t3" } });
    const missing = join(dir, "no-such-folder");
    const link = cli.addLink("demo", { kind: "repository", target: missing }, owner);
    let r = await post();
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe(
      `This topic's folder ${missing} isn't a T3 project. Choose a project.`,
    );
    const unlisted = join(dir, "unlisted");
    mkdirSync(unlisted);
    cli.updateLink("demo", link.id, { target: unlisted }, owner);
    r = await post();
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("isn't a T3 project");
    expect(t3.ran()).toBe(false);
    expect(cli.getTopic("demo").threads).toHaveLength(0);
  });

  it("502 when t3 fails, and nothing is attached", async () => {
    const t3 = fake("t3", "echo 'no project here' >&2; exit 2");
    topic();
    await start({ t3Cli: t3.path });
    const r = await api("/api/topics/demo/threads/new", {
      method: "POST",
      body: { text: "Hi", provider: "t3", project: "/p" },
    });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain("no project here");
    expect(cli.getTopic("demo").threads).toHaveLength(0);
    expect(ownerInputs()).toHaveLength(0);
  });

  it("starts a Claude Code session with a generated id, attached before it runs", async () => {
    const work = join(dir, "repo");
    mkdirSync(work);
    const claude = fake("claude");
    topic();
    cli.addLink("demo", { kind: "repository", target: work }, owner);
    await start({ claudeCli: claude.path });
    const r = await api("/api/topics/demo/threads/new", {
      method: "POST",
      body: {
        text: "Start here",
        provider: "claude-code",
        model: "claude-haiku-5-5",
        effort: "low",
      },
    });
    expect(r.status).toBe(201);
    await until(() => claude.ran());
    const id = r.body.providerThreadId as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claude.argv()).toEqual([
      "-p",
      "--session-id",
      id,
      "--allowedTools=Bash(axiom *)",
      "--model",
      "claude-haiku-5-5",
      "--effort",
      "low",
    ]);
    expect(claude.stdin()).toMatch(/^\[Axiom\] .*\n- Topic: `demo`[\s\S]*\n\nStart here$/);
    expect(claude.env()).not.toMatch(/^AXIOM_INTERNAL=/m);
    expect(readFileSync(join(claude.path, "..", "cwd"), "utf8").trim()).toBe(work);
    expect(cli.getTopic("demo").threads[0]).toMatchObject({
      provider: "claude-code",
      providerThreadId: id,
      title: "Start here",
    });
    expect(cli.threadCwd(r.body.id)).toBe(work);
    expect(cli.getThread(r.body.id)).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    expect(ownerInputs()).toHaveLength(1);
  });

  it("400 for Claude Code without a cwd or repository", async () => {
    topic();
    await start();
    const r = await api("/api/topics/demo/threads/new", {
      method: "POST",
      body: { text: "Hi", provider: "claude-code" },
    });
    expect(r.status).toBe(400);
    expect(cli.getTopic("demo").threads).toHaveLength(0);
  });

  it("404 for an unknown topic", async () => {
    await start();
    expect(
      (
        await api("/api/topics/nope/threads/new", {
          method: "POST",
          body: { text: "Hi", provider: "t3" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("GET /api/compose/options", () => {
  it("lists models and efforts for both providers", async () => {
    await start();
    const r = await api("/api/compose/options");
    expect(r.status).toBe(200);
    expect(r.body.providers["claude-code"].models).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(r.body.providers.t3.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("helpers", () => {
  it("agentEnv strips session variables", () => {
    expect(
      agentEnv({ A: "1", CLAUDECODE: "1", T3CODE_X: "1", CLAUDE_CODE_Y: "1", AXIOM_INTERNAL: "1" }),
    ).toEqual({ A: "1" });
  });
  it("parseStartedThreadId reads the known shapes and rejects the rest", () => {
    expect(parseStartedThreadId('{"threadId":"a"}')).toBe("a");
    expect(parseStartedThreadId('{"id":"b"}')).toBe("b");
    expect(() => parseStartedThreadId("started a thread")).toThrow();
    expect(() => parseStartedThreadId("{}")).toThrow();
  });
});
