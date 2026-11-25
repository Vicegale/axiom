import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupIfDue, newestBackupMs, runBackup } from "./backup.js";
import { type RunningServer, startServer } from "./index.js";
import { installService } from "./install.js";
import { main } from "./main.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;

const owner: Actor = { kind: "owner" };

let dir: string;
let dbPath: string;
let server: RunningServer;
let cli: Axiom; // a second connection, standing in for the CLI

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "axiom-server-"));
  dbPath = join(dir, "axiom.db");
  server = await startServer({
    dbPath,
    port: 0,
    webDist: join(dir, "no-web"),
    t3Dir: join(dir, "no-t3"),
  });
  cli = openDatabase(dbPath);
});

afterEach(async () => {
  cli.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(server.url + path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: Any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body ?? {} });

function topic(slug = "demo") {
  cli.createTopic({ slug, title: `Title ${slug}` }, owner);
  return slug;
}

describe("link descriptions", () => {
  it("includes descriptions in the topic detail and lets the owner edit a link", async () => {
    topic("t");
    const l = cli.addLink(
      "t",
      { kind: "artifact", target: "a.md", label: "A", description: "About a" },
      owner,
    );
    const detail = await api("/api/topics/t");
    expect(detail.body.links[0]).toMatchObject({ id: l.id, label: "A", description: "About a" });
    const ok = await api(`/api/topics/t/links/${l.id}`, {
      method: "PATCH",
      body: { description: "Changed", label: "" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ description: "Changed", label: null });
    expect(cli.getTopic("t").links[0]?.description).toBe("Changed");
    const clear = await api(`/api/topics/t/links/${l.id}`, {
      method: "PATCH",
      body: { description: "" },
    });
    expect(clear.body.description).toBeNull();
  });

  it("rejects bad link edits", async () => {
    topic("t");
    const l = cli.addLink("t", { kind: "artifact", target: "a.md" }, owner);
    const patch = (path: string, body: unknown) => api(path, { method: "PATCH", body });
    expect(
      (await patch(`/api/topics/t/links/${l.id}`, { description: "x".repeat(201) })).status,
    ).toBe(400);
    expect((await patch(`/api/topics/t/links/${l.id}`, { nope: 1 })).status).toBe(400);
    expect((await patch("/api/topics/t/links/999", { label: "x" })).status).toBe(404);
    expect((await patch("/api/topics/t/links/abc", { label: "x" })).status).toBe(400);
  });
});

describe("topics", () => {
  it("lists topics with views, parents, threads and the highlight flag", async () => {
    topic("a");
    cli.createTicket(
      { slug: "tk", title: "Ticket", jira: { key: "AX-1", url: "http://j/AX-1" } },
      owner,
    );
    cli.addTopicToTicket("a", "tk", owner);
    cli.attachThread(
      "a",
      { provider: "claude-code", providerThreadId: "t1", title: "main" },
      owner,
    );
    cli.raiseNotification("a", "monitor problem", "boom", owner);
    const { status, body } = await api("/api/topics");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      slug: "a",
      highlighted: true,
      stalePrompt: false,
      parents: [{ kind: "ticket", slug: "tk", jiraKey: "AX-1", locked: true }],
      threads: [{ provider: "claude-code", title: "main", open: true }],
    });
    expect(body[0].lastWorkedAt).toBeTypeOf("string");
  });

  it("filters by view and status, and hides closed topics unless all is set", async () => {
    topic("a");
    topic("b");
    await post("/api/topics/b/status", { status: "done" });
    await post("/api/topics/a/status", { status: "hitl" });
    expect((await api("/api/topics")).body.map((t: Any) => t.slug)).toEqual(["a"]);
    expect((await api("/api/topics?all=1")).body).toHaveLength(2);
    expect((await api("/api/topics?view=closed")).body.map((t: Any) => t.slug)).toEqual(["b"]);
    expect((await api("/api/topics?view=attention")).body.map((t: Any) => t.slug)).toEqual(["a"]);
    expect((await api("/api/topics?status=done")).body.map((t: Any) => t.slug)).toEqual(["b"]);
  });

  it("rejects an unknown view or status", async () => {
    expect((await api("/api/topics?view=nope")).status).toBe(400);
    expect((await api("/api/topics?status=nope")).status).toBe(400);
  });

  it("returns topic detail and 404 for an unknown slug", async () => {
    topic("a");
    cli.addLink("a", { kind: "pr", target: "http://pr/1" }, owner);
    const { status, body } = await api("/api/topics/a");
    expect(status).toBe(200);
    expect(body).toMatchObject({ slug: "a", muted: false, stalePrompt: false, highlighted: false });
    expect(body.links).toHaveLength(1);
    const missing = await api("/api/topics/zzz");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: "not-found", message: expect.any(String) } });
  });

  it("tells the UI how to open each thread", async () => {
    topic("a");
    const cc = cli.attachThread(
      "a",
      { provider: "claude-code", providerThreadId: "sess-1" },
      owner,
    );
    cli.attachThread("a", { provider: "t3", providerThreadId: "t3-1" }, owner);
    let threads = (await api("/api/topics/a")).body.threads;
    expect(threads[0].open).toEqual({ kind: "command", command: "claude --resume sess-1" });
    expect(threads[1].open).toBeNull(); // T3 is not readable in tests: no environment to link to
    cli.setThreadCwd(cc.id, "/home/me/it's here");
    threads = (await api("/api/topics/a")).body.threads;
    expect(threads[0].open.command).toBe("cd '/home/me/it'\\''s here' && claude --resume sess-1");
  });

  it("lists entries newest first with limit and before", async () => {
    topic("a");
    for (const n of [1, 2, 3]) cli.addEntry("a", { kind: "note", body: `n${n}` }, owner);
    const all = (await api("/api/topics/a/entries")).body;
    const notes = all.filter((e: Any) => e.kind === "note");
    expect(notes.map((e: Any) => e.body)).toEqual(["n3", "n2", "n1"]);
    expect(all[0].id).toBeGreaterThan(all[1].id);
    const page = (await api(`/api/topics/a/entries?limit=1&before=${notes[0].id}`)).body;
    expect(page).toHaveLength(1);
    expect(page[0].body).toBe("n2");
    expect((await api("/api/topics/a/entries?limit=0")).status).toBe(400);
    expect((await api("/api/topics/a/entries?before=x")).status).toBe(400);
    expect((await api("/api/topics/zzz/entries")).status).toBe(404);
  });

  it("clears the highlight when the topic is opened", async () => {
    topic("a");
    cli.raiseNotification("a", "agent asked", "q?", owner);
    expect((await api("/api/topics/a")).body.highlighted).toBe(true);
    expect((await post("/api/topics/a/open")).status).toBe(200);
    expect((await api("/api/topics/a")).body.highlighted).toBe(false);
    expect((await api("/api/notifications")).body.notifications).toHaveLength(0);
    expect((await post("/api/topics/zzz/open")).status).toBe(404);
  });

  it("sets status with a reason and validates it", async () => {
    topic("a");
    const ok = await post("/api/topics/a/status", { status: "blocked", reason: "waiting" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("blocked");
    const entries = (await api("/api/topics/a/entries")).body;
    expect(entries[0]).toMatchObject({ kind: "status change", author: "axiom" });
    expect((await post("/api/topics/a/status", { status: "bogus" })).status).toBe(400);
    expect((await post("/api/topics/a/status", {})).status).toBe(400);
    expect((await post("/api/topics/zzz/status", { status: "idle" })).status).toBe(404);
  });

  it("rejects a body that is not JSON", async () => {
    topic("a");
    const res = await fetch(`${server.url}/api/topics/a/status`, { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
  });

  it("mutes and unmutes, keeping the highlight", async () => {
    topic("a");
    cli.raiseNotification("a", "agent asked", "q?", owner);
    expect((await post("/api/topics/a/mute", { muted: true })).body.muted).toBe(true);
    expect((await api("/api/topics/a")).body.highlighted).toBe(true);
    expect((await post("/api/topics/a/mute", { muted: "yes" })).status).toBe(400);
    expect((await post("/api/topics/a/mute", { muted: false })).body.muted).toBe(false);
    expect((await post("/api/topics/zzz/mute", { muted: true })).status).toBe(404);
  });

  it("marks a topic stale and dismisses the stale prompt", async () => {
    topic("a");
    topic("b");
    expect((await post("/api/topics/a/stale")).body.status).toBe("stale");
    const dismissed = await post("/api/topics/b/stale-prompt/dismiss");
    expect(dismissed.status).toBe(200);
    expect(cli.getTopic("b").stalePromptDismissed).toBe(true);
    expect((await post("/api/topics/zzz/stale")).status).toBe(404);
    expect((await post("/api/topics/zzz/stale-prompt/dismiss")).status).toBe(404);
  });

  it("attaches a thread and refuses a duplicate", async () => {
    topic("a");
    const body = {
      provider: "t3",
      providerThreadId: "x1",
      environmentId: "env",
      title: "T3 thread",
    };
    const ok = await post("/api/topics/a/threads", body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ provider: "t3", providerThreadId: "x1", title: "T3 thread" });
    expect((await post("/api/topics/a/threads", body)).status).toBe(409);
    expect((await post("/api/topics/a/threads", { ...body, provider: "nope" })).status).toBe(400);
    expect((await post("/api/topics/zzz/threads", body)).status).toBe(404);
  });
});

describe("attention reason", () => {
  function threadOf(slug: string) {
    return cli.attachThread(
      slug,
      { provider: "claude-code", providerThreadId: `t-${slug}` },
      owner,
    );
  }

  it("is the question the agent asked, and survives opening the topic", async () => {
    topic("a");
    const th = threadOf("a");
    cli.threadWaitingOnOwner(th.id, "Which way?");
    const list = (await api("/api/topics")).body;
    expect(list[0].attention).toMatchObject({ reason: "agent asked", text: "Which way?" });
    expect(typeof list[0].attention.at).toBe("string");
    await post("/api/topics/a/open");
    expect((await api("/api/topics")).body[0].attention.text).toBe("Which way?");
    expect((await api("/api/topics/a")).body.attention).toMatchObject({ reason: "agent asked" });
  });

  it("is the error message for an error thread", async () => {
    topic("a");
    cli.threadError(threadOf("a").id, "process exited (code 1)");
    expect((await api("/api/topics/a")).body.attention).toMatchObject({
      reason: "error",
      text: "process exited (code 1)",
    });
  });

  it("uses a newer manual status change with its reason", async () => {
    topic("a");
    cli.threadWaitingOnOwner(threadOf("a").id, "old question");
    cli.setTopicStatus("a", "wip", owner);
    cli.setTopicStatus("a", "hitl", owner, "need a decision on scope");
    expect((await api("/api/topics/a")).body.attention).toMatchObject({
      reason: "agent asked",
      text: "need a decision on scope",
    });
  });

  it("is null outside hitl and error", async () => {
    topic("a");
    const th = threadOf("a");
    cli.threadWaitingOnOwner(th.id, "q");
    cli.threadWorking(th.id);
    expect((await api("/api/topics/a")).body.attention).toBeNull();
    topic("b");
    expect((await api("/api/topics")).body.every((t: Any) => t.attention === null)).toBe(true);
  });

  it("covers a null-status topic with an open hitl thread", async () => {
    topic("a");
    const t1 = threadOf("a");
    const t2 = cli.attachThread("a", { provider: "claude-code", providerThreadId: "t2" }, owner);
    const t3 = cli.attachThread("a", { provider: "claude-code", providerThreadId: "t3" }, owner);
    cli.threadWorking(t1.id);
    cli.threadWorking(t2.id);
    expect((await api("/api/topics/a")).body.attention).toBeNull();
    cli.threadWaitingOnOwner(t3.id, "which?");
    const d = (await api("/api/topics/a")).body;
    expect(d.status).toBeNull();
    expect(d.attention).toMatchObject({ reason: "agent asked", text: "which?" });
  });
});

describe("monitors and entries", () => {
  it("confirms a monitor target", async () => {
    topic("a");
    const m = cli.addMonitorTarget("a", { kind: "url" }, owner);
    const ok = await post(`/api/monitors/${m.id}/confirm`);
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe("confirmed");
    expect((await post("/api/monitors/9999/confirm")).status).toBe(404);
    expect((await post("/api/monitors/abc/confirm")).status).toBe(400);
  });

  it("deletes an entry", async () => {
    topic("a");
    const e = cli.addEntry("a", { kind: "note", body: "secret" }, owner);
    expect((await api(`/api/entries/${e.id}`, { method: "DELETE" })).status).toBe(200);
    expect(cli.listEntries("a").some((x) => x.id === e.id)).toBe(false);
    expect((await api(`/api/entries/${e.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("tickets and epics", () => {
  it("lists them with Jira lock info and topic counts", async () => {
    topic("a");
    topic("b");
    cli.createEpic({ slug: "ep", title: "Epic", jira: { key: "AX-9", url: "http://j/9" } }, owner);
    cli.createTicket({ slug: "tk", title: "Ticket" }, owner);
    cli.addTicketToEpic("tk", "ep", owner);
    cli.addTopicToTicket("a", "tk", owner);
    cli.addTopicToEpic("b", "ep", owner);
    const tickets = (await api("/api/tickets")).body;
    expect(tickets).toEqual([
      expect.objectContaining({
        slug: "tk",
        locked: false,
        topicCount: 1,
        epics: [{ slug: "ep", title: "Epic" }],
      }),
    ]);
    const epics = (await api("/api/epics")).body;
    expect(epics).toEqual([
      expect.objectContaining({
        slug: "ep",
        locked: true,
        jiraKey: "AX-9",
        ticketCount: 1,
        topicCount: 2,
      }),
    ]);
  });
});

describe("notifications", () => {
  it("hides muted kinds and muted topics and counts them", async () => {
    topic("a");
    topic("b");
    cli.raiseNotification("a", "agent asked", "q", owner);
    cli.raiseNotification("a", "pr review", "r", owner);
    cli.raiseNotification("b", "agent asked", "q", owner);
    cli.setTopicMuted("b", true, owner);
    await api("/api/settings", { method: "PUT", body: { mutedKinds: ["pr review"] } });
    const { body } = await api("/api/notifications");
    expect(body.notifications.map((n: Any) => `${n.topicSlug}:${n.kind}`)).toEqual([
      "a:agent asked",
    ]);
    expect(body.hiddenCount).toBe(2);
  });
});

describe("settings", () => {
  it("returns defaults and stores updates", async () => {
    expect((await api("/api/settings")).body).toEqual({
      mutedKinds: [],
      staleAfterDays: 14,
      layout: "inbox",
      theme: "system",
      summaries: { enabled: true },
    });
    const put = await api("/api/settings", {
      method: "PUT",
      body: { mutedKinds: ["jira changed"], staleAfterDays: 30, layout: "inbox", theme: "dark" },
    });
    expect(put.status).toBe(200);
    expect((await api("/api/settings")).body).toEqual({
      mutedKinds: ["jira changed"],
      staleAfterDays: 30,
      layout: "inbox",
      theme: "dark",
      summaries: { enabled: true },
    });
    expect(cli.getSetting("theme")).toBe("dark");
  });

  it("validates every field", async () => {
    for (const body of [
      { theme: "blue" },
      { layout: "grid" },
      { staleAfterDays: 0 },
      { staleAfterDays: 1.5 },
      { mutedKinds: ["nope"] },
      { unknown: 1 },
    ]) {
      expect((await api("/api/settings", { method: "PUT", body })).status).toBe(400);
    }
    expect((await api("/api/settings")).body.theme).toBe("system");
  });
});

describe("health", () => {
  it("reports server info, the latest Claude Code event and T3 state", async () => {
    const first = (await api("/api/health")).body;
    expect(first.server).toMatchObject({ dbPath, version: expect.any(String) });
    expect(first.server.startedAt).toBeTypeOf("string");
    expect(first.server.lastBackupAt).toBeTypeOf("string"); // the startup backup
    expect(first.claudeCode.lastEventAt).toBeNull();
    expect(first.t3.state).toBe("unavailable");
    expect(first.t3.pinned).toEqual({
      serverVersion: "0.1.11-nightly.20261118.4890",
      migration: 98,
    });

    topic("a");
    const t = cli.attachThread("a", { provider: "claude-code", providerThreadId: "c1" }, owner);
    cli.threadWorking(t.id);
    cli.threadStopped(t.id);
    const after = (await api("/api/health")).body;
    expect(after.claudeCode.lastEventAt).toBeTypeOf("string");
  });

  it("counts any hook run, even with no attached thread", async () => {
    expect((await api("/api/health")).body.claudeCode.lastEventAt).toBeNull();
    cli.recordHookEvent();
    expect((await api("/api/health")).body.claudeCode.lastEventAt).toBeTypeOf("string");
  });
});

describe("unknown routes and guards", () => {
  it("answers unknown /api paths with a JSON 404", async () => {
    const r = await api("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not-found");
  });

  it("refuses a foreign Origin and a foreign Host", async () => {
    const res = await fetch(`${server.url}/api/topics/x/open`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const host = new URL(server.url);
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: host.hostname,
          port: host.port,
          path: "/api/health",
          headers: { host: "evil.example" },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("startup maintenance", () => {
  it("raises stale prompts at startup", async () => {
    const old = openDatabase(join(dir, "other.db"), {
      now: () => new Date("2020-01-01T00:00:00Z"),
    });
    old.createTopic({ slug: "old", title: "Old" }, owner);
    old.setTopicStatus("old", "idle", owner);
    old.close();
    const s2 = await startServer({
      dbPath: join(dir, "other.db"),
      port: 0,
      webDist: dir,
      t3Dir: join(dir, "no-t3"),
    });
    try {
      const res = await fetch(`${s2.url}/api/topics/old`);
      const body = (await res.json()) as Any;
      expect(body.stalePrompt).toBe(true);
      expect(body.highlighted).toBe(true);
    } finally {
      await s2.close();
    }
  });
});

describe("server-sent events", () => {
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    needle: string,
    ms: number,
  ) {
    const dec = new TextDecoder();
    let text = "";
    const deadline = Date.now() + ms;
    while (!text.includes(needle)) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`timed out waiting for ${needle}; got ${JSON.stringify(text)}`);
      const r = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
      ]);
      if (r === null) continue;
      if (r.done) break;
      text += dec.decode(r.value);
    }
    return text;
  }

  it("pushes a change event within a second of a write by another connection", async () => {
    const res = await fetch(`${server.url}/api/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, "event: ping", 2000);
    const started = Date.now();
    cli.createTopic({ slug: "from-cli", title: "From the CLI" }, owner);
    const text = await readUntil(reader, "event: change", 1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).toMatch(/data: \{"at":"\d{4}-/);
    await reader.cancel();
  });

  it("also pushes after the server's own writes", async () => {
    topic("a");
    const res = await fetch(`${server.url}/api/events`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, "event: ping", 2000);
    await post("/api/topics/a/mute", { muted: true });
    await readUntil(reader, "event: change", 1000);
    await reader.cancel();
  });
});

describe("static files", () => {
  it("serves the web app with an index.html fallback, and not for /api", async () => {
    const web = join(dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<h1>axiom</h1>");
    writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
    const s2 = await startServer({
      dbPath: join(dir, "web.db"),
      port: 0,
      webDist: web,
      t3Dir: join(dir, "no-t3"),
    });
    try {
      const root = await fetch(`${s2.url}/`);
      expect(await root.text()).toBe("<h1>axiom</h1>");
      expect(root.headers.get("content-type")).toContain("text/html");
      const js = await fetch(`${s2.url}/assets/app.js`);
      expect(js.headers.get("content-type")).toContain("javascript");
      expect(await js.text()).toBe("console.log(1)");
      expect(await (await fetch(`${s2.url}/topics/some-slug`)).text()).toBe("<h1>axiom</h1>");
      expect((await fetch(`${s2.url}/api/nope`)).headers.get("content-type")).toContain("json");
      const traversal = await fetch(`${s2.url}/..%2Fweb.db`);
      expect(await traversal.text()).toBe("<h1>axiom</h1>");
    } finally {
      await s2.close();
    }
  });

  it("explains in plain text when the web app is not built", async () => {
    const res = await fetch(`${server.url}/`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("not built");
  });
});

describe("backup", () => {
  it("wrote one at startup next to the database", () => {
    expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
    expect(newestBackupMs(join(dir, "backups"))).not.toBeNull();
  });

  it("creates a dated copy and keeps only the newest seven", () => {
    const backups = join(dir, "bk");
    topic("a");
    for (let d = 1; d <= 10; d++) {
      runBackup(cli.db, backups, new Date(Date.UTC(2026, 0, d, 12)));
    }
    const names = readdirSync(backups).sort();
    expect(names).toEqual(
      [4, 5, 6, 7, 8, 9, 10].map((d) => `axiom-2026-01-${String(d).padStart(2, "0")}.db`),
    );
    const copy = openDatabase(join(backups, names[0] as string));
    expect(copy.getTopic("a").slug).toBe("a");
    copy.close();
  });

  it("only runs when the newest backup is older than 24 hours", () => {
    const backups = join(dir, "bk2");
    const t0 = new Date("2026-03-01T12:00:00Z");
    expect(backupIfDue(cli.db, backups, t0)).not.toBeNull();
    const file = join(backups, "axiom-2026-03-01.db");
    utimesSync(file, t0, t0);
    expect(backupIfDue(cli.db, backups, new Date(t0.getTime() + 23 * 3600_000))).toBeNull();
    expect(backupIfDue(cli.db, backups, new Date(t0.getTime() + 25 * 3600_000))).not.toBeNull();
  });
});

describe("install", () => {
  it("--dry-run prints the unit and writes nothing", async () => {
    const home = join(dir, "home");
    let out = "";
    const started = await main(["install", "--dry-run"], { stdout: (t) => (out += t), home });
    expect(started).toBe(false);
    expect(out).toContain(`ExecStart=${process.execPath}`);
    expect(out).toContain("cli.js");
    expect(out).toContain("Restart=on-failure");
    expect(out).toContain("Environment=AXIOM_PORT=4477");
    expect(() => readdirSync(home)).toThrow();
  });

  it("writes the unit under a temporary HOME and prints the enable commands", async () => {
    const home = join(dir, "home2");
    let out = "";
    await main(["install", "--port", "5000"], { stdout: (t) => (out += t), home });
    expect(out).toContain("systemctl --user daemon-reload");
    expect(out).toContain("systemctl --user enable --now axiom.service");
    const r = installService({ home, dryRun: true });
    expect(r.path).toBe(join(home, ".config", "systemd", "user", "axiom.service"));
    const { readFileSync } = await import("node:fs");
    const unit = readFileSync(r.path, "utf8");
    expect(unit).toContain("Environment=AXIOM_PORT=5000");
    expect(unit).toMatch(/ExecStart=\S+ \S+cli\.js/);
  });
});

describe("tasks", () => {
  it("lists a topic's tasks with dependencies and the waiting flag, in order", async () => {
    topic("t");
    cli.createTask("t", { key: "S0", title: "Setup" }, owner);
    cli.createTask("t", { key: "S1", title: "Core", dependsOn: ["S0"], doneWhen: "tests" }, owner);
    const { status, body } = await api("/api/topics/t/tasks");
    expect(status).toBe(200);
    expect(body.map((x: Any) => x.key)).toEqual(["S0", "S1"]);
    expect(body[1]).toMatchObject({
      status: "to do",
      doneWhen: "tests",
      dependsOn: ["S0"],
      waiting: true,
    });
    expect(body[0]).toMatchObject({ dependents: ["S1"], waiting: false });
    expect((await api("/api/topics/nope/tasks")).status).toBe(404);
  });

  it("puts task counts on topic list items and on the topic", async () => {
    topic("t");
    topic("empty");
    cli.createTask("t", { key: "A", title: "a" }, owner);
    cli.createTask("t", { key: "B", title: "b" }, owner);
    cli.setTaskStatus("t", "A", "done", owner);
    const list = (await api("/api/topics")).body as Any[];
    expect(list.find((x) => x.slug === "t").taskCounts).toEqual({ total: 2, done: 1 });
    expect(list.find((x) => x.slug === "empty").taskCounts).toEqual({ total: 0, done: 0 });
    expect((await api("/api/topics/t")).body.taskCounts).toEqual({ total: 2, done: 1 });
  });

  it("lets the owner set a task's status, and rejects bad input", async () => {
    topic("t");
    cli.createTask("t", { key: "A", title: "a" }, owner);
    const ok = await post("/api/topics/t/tasks/A/status", { status: "wip" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ key: "A", status: "wip" });
    expect(cli.getTask("t", "A").status).toBe("wip");
    expect((await post("/api/topics/t/tasks/A/status", { status: "idle" })).status).toBe(400);
    expect((await post("/api/topics/t/tasks/A/status", {})).status).toBe(400);
    expect((await post("/api/topics/t/tasks/Z/status", { status: "done" })).status).toBe(404);
    const kinds = cli.listEntries("t").filter((e) => e.kind === "status change");
    expect(kinds[0]?.data).toMatchObject({ task: "A", to: "wip", by: "owner" });
  });
});
