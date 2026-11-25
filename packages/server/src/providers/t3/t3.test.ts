import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { T3_VERSION, T3Fixture } from "../../test-t3.js";
import { decide, T3Provider } from "./provider.js";
import { parseQuestions, readT3Meta, T3Db } from "./reader.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner: Actor = { kind: "owner" };

let root: string;
let ax: Axiom;
let t3: T3Fixture;
let provider: T3Provider;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axiom-t3-"));
  ax = openDatabase(join(root, "axiom.db"));
  t3 = new T3Fixture(join(root, "t3"));
  provider = new T3Provider({ ax, dir: t3.dir });
});
afterEach(() => {
  t3.close();
  ax.close();
  rmSync(root, { recursive: true, force: true });
});

function attach(id: string, slug = `topic-${id}`) {
  ax.createTopic({ slug, title: slug }, owner);
  return ax.attachThread(slug, { provider: "t3", providerThreadId: id }, owner);
}
const thread = (id: string) => ax.findThread({ provider: "t3", providerThreadId: id });
const topicStatus = (id: string) => ax.getTopic(`topic-${id}`).status;
const events = (id: string) =>
  ax
    .listEntries(`topic-${id}`)
    .filter((e) => e.kind === "thread event")
    .map((e) => (e.data as { event: string }).event);

describe("reader", () => {
  it("reads the meta files", () => {
    expect(readT3Meta(t3.dir)).toEqual({
      serverVersion: T3_VERSION,
      port: 3999,
      environmentId: "env-test",
    });
    expect(readT3Meta(join(root, "nowhere"))).toEqual({
      serverVersion: null,
      port: null,
      environmentId: null,
    });
  });

  it("maps runs and sessions to session statuses", () => {
    const cases: [string | null, string | null, string][] = [
      [null, null, "idle"],
      [null, "stopped", "stopped"],
      [null, "error", "error"],
      ["preparing", null, "starting"],
      ["queued", "ready", "starting"],
      ["starting", null, "starting"],
      ["running", "running", "running"],
      ["waiting", "waiting", "running"],
      ["completed", "ready", "ready"],
      ["completed", "stopped", "ready"],
      ["failed", "error", "error"],
      ["interrupted", "ready", "interrupted"],
      ["cancelled", "ready", "interrupted"],
    ];
    const db = T3Db.open(t3.dir);
    try {
      cases.forEach(([run, session, want], i) => {
        const id = `t${i}`;
        t3.thread(id);
        if (run) t3.run(id, 1, run);
        if (session) t3.session(id, session);
        expect(db.thread(id, null)?.status, `${run}/${session}`).toBe(want);
      });
    } finally {
      db.close();
    }
  });

  it("uses the newest run, reads the last error and the pending request text", () => {
    t3.thread("a").run("a", 1, "failed").run("a", 2, "running").session("a", "running", "boom");
    const q = t3.request("a", "user_input", "Which database?");
    t3.request("a", "command", "Run rm -rf build?");
    t3.thread("b").request("b", "command", null);
    const db = T3Db.open(t3.dir);
    try {
      const a = db.thread("a", "env-test");
      expect(a?.status).toBe("running");
      expect(a?.lastError).toBe("boom");
      expect(a?.environmentId).toBe("env-test");
      expect(a?.pendingRequests.map((r) => r.text)).toEqual([
        "Which database?",
        "Run rm -rf build?",
      ]);
      expect(db.thread("b", null)?.pendingRequests[0]?.text).toBe("Approval requested");
      t3.resolve(q);
      expect(db.thread("a", null)?.pendingRequests).toHaveLength(1);
      expect(db.thread("nope", null)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("parses the structured questions of a pending request, and skips malformed ones", () => {
    t3.thread("q");
    const id = t3.request("q", "user_input", "x", {
      questions: [
        {
          id: "Which windows?",
          header: "Clear panes",
          question: "Which windows should be clear?",
          multiSelect: true,
          options: [
            { label: "Plant cars only", description: "Two a side" },
            { label: "All", description: "" },
            { description: "no label: skipped" },
          ],
        },
        { question: "No id: the text is the id", options: "not a list" },
        { id: "no question text", header: "skipped" },
        "garbage",
      ],
    });
    t3.request("q", "command", "Run it?", { requestKind: "file-change" });
    const db = T3Db.open(t3.dir);
    try {
      const [question, approval] = db.pendingRequests("q");
      expect(question?.id).toBe(id);
      expect(question?.kind).toBe("user_input");
      expect(question?.questions).toEqual([
        {
          id: "Which windows?",
          header: "Clear panes",
          question: "Which windows should be clear?",
          multiSelect: true,
          options: [
            { label: "Plant cars only", description: "Two a side" },
            { label: "All", description: "" },
          ],
        },
        {
          id: "No id: the text is the id",
          header: "",
          question: "No id: the text is the id",
          multiSelect: false,
          options: [],
        },
      ]);
      expect(approval?.kind).toBe("command");
      expect(approval?.questions).toEqual([]);
      expect(approval?.requestKind).toBe("file-change");
      expect(parseQuestions({ questions: "nope" })).toEqual([]);
      expect(parseQuestions(null)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("lists live non-subagent threads, newest first, minus excluded ones, with a limit", () => {
    t3.thread("old", { updatedAt: "2026-11-20T00:00:00.000Z" });
    t3.thread("new", { updatedAt: "2026-11-25T09:00:00.000Z" });
    t3.thread("mid", { updatedAt: "2026-11-22T00:00:00.000Z" }).request("mid", "user_input", "?");
    t3.thread("sub", { subagent: true });
    t3.thread("gone", { deleted: true });
    t3.thread("arch", { archived: true });
    const db = T3Db.open(t3.dir);
    try {
      const all = db.listThreads("env-test");
      expect(all.map((t) => t.id)).toEqual(["new", "mid", "old"]);
      expect(all[1]).toEqual({
        id: "mid",
        title: "Synthetic mid",
        environmentId: "env-test",
        status: "waiting",
        updatedAt: "2026-11-22T00:00:00.000Z",
      });
      expect(db.listThreads(null, { exclude: new Set(["new"]) }).map((t) => t.id)).toEqual([
        "mid",
        "old",
      ]);
      expect(db.listThreads(null, { limit: 1 })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("lists live projects, pinned first then by title, with the default-model flag", () => {
    t3.project("z", { title: "Zed", pinned: true, root: "/work/zed" })
      .project("b", { title: "beta", model: true })
      .project("a", { title: "Alpha" })
      .project("gone", { title: "Gone", deleted: true })
      .project("old", { title: "Old", archived: true });
    const db = T3Db.open(t3.dir);
    try {
      expect(db.listProjects()).toEqual([
        { id: "z", title: "Zed", workspaceRoot: "/work/zed", hasDefaultModel: false, pinned: true },
        {
          id: "a",
          title: "Alpha",
          workspaceRoot: "/work/a",
          hasDefaultModel: false,
          pinned: false,
        },
        { id: "b", title: "beta", workspaceRoot: "/work/b", hasDefaultModel: true, pinned: false },
      ]);
      expect(provider.listProjects().map((p) => p.id)).toEqual(["z", "a", "b"]);
    } finally {
      db.close();
    }
  });

  it("opens the database read-only", () => {
    const db = T3Db.open(t3.dir);
    try {
      // @ts-expect-error the handle is private; reaching in proves the connection cannot write
      expect(() => db.db.exec("DELETE FROM effect_sql_migrations")).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });
});

describe("sync transitions", () => {
  it("running becomes working, and ready afterwards becomes stopped (idle topic, notification)", () => {
    t3.thread("a");
    attach("a");
    expect(provider.sync()).toBe(0); // idle in T3, idle in Axiom
    t3.run("a", 1, "running");
    expect(provider.sync()).toBe(1);
    expect(thread("a")?.status).toBe("wip");
    expect(topicStatus("a")).toBe("wip");
    t3.run("a", 1, "completed").session("a", "ready");
    expect(provider.sync()).toBe(1);
    expect(thread("a")?.status).toBe("idle");
    expect(topicStatus("a")).toBe("idle");
    expect(events("a")).toEqual(["working", "stopped"]);
    expect(ax.listNotifications().map((n) => n.kind)).toEqual(["agent stopped"]);
  });

  it("a pending approval becomes waiting on the owner (hitl) with its text, and stays hitl after stop", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    provider.sync();
    const req = t3.request("a", "command", "Run npm publish?");
    t3.run("a", 1, "waiting");
    expect(provider.sync()).toBe(1);
    expect(topicStatus("a")).toBe("hitl");
    const note = ax.listNotifications().find((n) => n.kind === "agent asked");
    expect(note?.body).toBe("Run npm publish?");
    // answered: the run goes on, then stops; the stop table keeps hitl
    t3.resolve(req).run("a", 1, "running");
    expect(provider.sync()).toBe(1);
    expect(topicStatus("a")).toBe("wip");
    t3.run("a", 1, "completed");
    provider.sync();
    expect(topicStatus("a")).toBe("idle");
  });

  it("a question that is still open when the run stops keeps the topic hitl", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    provider.sync();
    t3.request("a", "user_input", "Which way?");
    provider.sync();
    t3.run("a", 1, "completed");
    expect(provider.sync()).toBe(0);
    expect(topicStatus("a")).toBe("hitl");
  });

  it("fills in an untitled thread's title from T3, and keeps a title given by hand", () => {
    t3.thread("a").run("a", 1, "running");
    t3.thread("b").run("b", 1, "running");
    attach("a");
    attach("b");
    const b = thread("b");
    if (b) ax.db.prepare("UPDATE thread SET title = 'Mine' WHERE id = ?").run(b.id);
    provider.sync();
    expect(thread("a")?.title).toBeTruthy();
    expect(thread("a")?.title).not.toBe("Mine");
    expect(thread("b")?.title).toBe("Mine");
  });

  it("a run that starts and finishes between two polls still counts as working then stopped", () => {
    t3.thread("a").run("a", 1, "completed");
    attach("a");
    expect(provider.sync()).toBe(0); // first sighting: just recorded
    expect(provider.sync()).toBe(0); // nothing new
    t3.run("a", 2, "completed"); // ran and finished unseen
    expect(provider.sync()).toBe(1);
    expect(ax.listNotifications().some((n) => n.kind === "agent stopped")).toBe(true);
    expect(provider.sync()).toBe(0); // not replayed
  });

  it("a failed run becomes an error with the last error", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    provider.sync();
    t3.run("a", 1, "failed").session("a", "error", "provider crashed");
    expect(provider.sync()).toBe(1);
    expect(thread("a")?.status).toBe("error");
    expect(topicStatus("a")).toBe("error");
    expect(ax.listNotifications().find((n) => n.kind === "error")?.body).toBe("provider crashed");
  });

  it("ignores an error that predates the attach", () => {
    t3.thread("a", { updatedAt: "2020-01-01T00:00:00.000Z" })
      .run("a", 1, "failed")
      .session("a", "error", "old");
    attach("a");
    expect(provider.sync()).toBe(0);
    expect(topicStatus("a")).toBe("idle");
  });

  it("does not repeat events across ticks or across a restart", () => {
    t3.thread("a").run("a", 1, "running");
    attach("a");
    expect(provider.sync()).toBe(1);
    expect(provider.sync()).toBe(0);
    expect(provider.sync()).toBe(0);
    const restarted = new T3Provider({ ax, dir: t3.dir });
    expect(restarted.sync()).toBe(0);
    t3.run("a", 1, "completed");
    expect(restarted.sync()).toBe(1);
    expect(new T3Provider({ ax, dir: t3.dir }).sync()).toBe(0);
    expect(events("a")).toEqual(["working", "stopped"]);
  });

  it("a thread deleted or archived in T3, or missing from it, ends", () => {
    t3.thread("del").thread("arch").thread("miss");
    for (const id of ["del", "arch", "miss"]) attach(id);
    t3.remove("del");
    t3.db
      .prepare(
        "UPDATE orchestration_v2_projection_threads SET archived_at = '2026-11-25T10:00:00.000Z' WHERE thread_id = 'arch'",
      )
      .run();
    t3.db.prepare("DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'miss'").run();
    expect(provider.sync()).toBe(3);
    for (const id of ["del", "arch", "miss"]) {
      expect(thread(id)?.endedAt).not.toBeNull();
      expect(thread(id)?.endReason).toBe("removed in T3");
    }
    expect(provider.sync()).toBe(0);
  });

  it("only touches threads of provider t3", () => {
    ax.createTopic({ slug: "cc", title: "cc" }, owner);
    ax.attachThread("cc", { provider: "claude-code", providerThreadId: "a" }, owner);
    t3.thread("a").run("a", 1, "running");
    expect(provider.sync()).toBe(0);
    expect(ax.findThread({ provider: "claude-code", providerThreadId: "a" })?.status).toBe("idle");
  });
});

describe("version pin and health", () => {
  it("is ok when the version and migration match the pin", () => {
    provider.sync();
    const h = provider.health();
    expect(h.state).toBe("ok");
    expect(h.serverVersion).toBe(T3_VERSION);
    expect(h.migration).toBe(98);
    expect(h.pinned).toEqual({ serverVersion: T3_VERSION, migration: 98 });
    expect(h.lastReadAt).not.toBeNull();
    expect(h.detail).toBeNull();
  });

  it("is untested-version, still syncing, when the migration differs", () => {
    t3.db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'x')").run();
    t3.thread("a").run("a", 1, "running");
    attach("a");
    expect(provider.sync()).toBe(1);
    const h = provider.health();
    expect(h.state).toBe("untested-version");
    expect(h.migration).toBe(99);
    expect(h.detail).toMatch(/migration 99/);
  });

  it("is untested-version when the server version differs", () => {
    writeFileSync(join(t3.dir, "server-runtime.json"), JSON.stringify({ serverVersion: "9.9.9" }));
    provider.sync();
    expect(provider.health().state).toBe("untested-version");
    expect(provider.health().serverVersion).toBe("9.9.9");
  });

  it("honours a changed pin setting", () => {
    ax.setSetting("t3Pin", { serverVersion: "9.9.9", migration: 1 }, owner);
    provider.sync();
    expect(provider.health().state).toBe("untested-version");
    expect(provider.health().pinned).toEqual({ serverVersion: "9.9.9", migration: 1 });
  });

  it("is unavailable when the folder or database is missing, then recovers", () => {
    const missing = new T3Provider({ ax, dir: join(root, "nowhere") });
    expect(missing.sync()).toBe(0);
    expect(missing.health().state).toBe("unavailable");
    expect(missing.health().detail).toMatch(/not found/);
    expect(missing.health().lastReadAt).toBeNull();
    provider.sync();
    expect(provider.health().state).toBe("ok");
    t3.db.exec("DROP TABLE orchestration_v2_projection_runs");
    expect(provider.sync()).toBe(0);
    expect(provider.health().state).toBe("unavailable");
    expect(provider.health().lastReadAt).not.toBeNull();
  });

  it("does not end threads while T3 is unavailable", () => {
    t3.thread("a");
    attach("a");
    const p = new T3Provider({ ax, dir: join(root, "nowhere") });
    expect(p.sync()).toBe(0);
    expect(thread("a")?.endedAt).toBeNull();
  });

  it("notices a refresh request newer than the last sync", async () => {
    provider.sync();
    expect(provider.refreshRequested()).toBe(false);
    await sleep(5);
    ax.requestProviderRefresh("t3");
    expect(provider.refreshRequested()).toBe(true);
    await sleep(5);
    provider.sync();
    expect(provider.refreshRequested()).toBe(false);
  });
});

describe("decide with running subagents", () => {
  const base = {
    id: 1,
    topicId: 1,
    provider: "t3",
    providerThreadId: "x",
    environmentId: null,
    title: null,
    status: "wip",
    declaredStatus: null,
    waitingOnOwner: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
  } as unknown as Parameters<typeof decide>[0];
  const ready = {
    status: "ready",
    pendingRequests: [],
    removed: false,
    updatedAt: "2026-01-01T00:00:01.000Z",
    lastError: null,
  } as unknown as Parameters<typeof decide>[1];
  it("does not stop a wip thread while its subagents run", () => {
    expect(decide(base, ready, 1)).toBeNull();
    expect(decide(base, ready, 0)).toEqual({ kind: "stopped" });
  });
});

describe("threadUrl", () => {
  it("deep-links into the T3 desktop app when the environment is known", () => {
    const dir = mkdtempSync(join(tmpdir(), "axiom-t3url-"));
    try {
      const ax2 = openDatabase(join(dir, "a.db"));
      const p = new T3Provider({ ax: ax2, dir });
      expect(p.threadUrl("x", null)).toBeNull();
      writeFileSync(join(dir, "environment-id"), "env-1");
      expect(p.threadUrl("mcp:launch:1", null)).toBe("t3code://threads/env-1/mcp:launch:1");
      expect(p.threadUrl("a b", "env-2")).toBe("t3code://threads/env-2/a%20b");
      ax2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the activity line", () => {
  const line = (id: string) => {
    const db = T3Db.open(t3.dir);
    try {
      return db.thread(id, null)?.activity ?? null;
    } finally {
      db.close();
    }
  };

  it("says nothing for a thread without steps", () => {
    t3.thread("a");
    expect(line("a")).toBeNull();
  });

  it("words the newest step of each item type", () => {
    t3.thread("a");
    const cases: [string, Record<string, unknown>, string][] = [
      ["command_execution", { input: "npm test -- --run\nsecond" }, "$ npm test -- --run"],
      ["command_execution", { input: "" }, "Running a command"],
      [
        "dynamic_tool",
        { toolName: "Read", title: "Read /x/y/parser.ts", input: { file_path: "/x/y/parser.ts" } },
        "Reading parser.ts",
      ],
      ["dynamic_tool", { toolName: "Grep", input: { pattern: "TODO" } }, "Searching TODO"],
      [
        "dynamic_tool",
        { toolName: "mcp__t3-code__t3_thread_read", input: {} },
        "t3-code: t3_thread_read",
      ],
      ["dynamic_tool", { title: "Some tool" }, "Some tool"],
      ["file_change", { fileName: "/p/q/app.ts", diffStr: "..." }, "Editing app.ts"],
      ["web_search", { patterns: ["a query"] }, "Searching the web"],
      ["subagent", { title: "Check the schema" }, "Subagent: Check the schema"],
      [
        "reasoning",
        { text: "I need to look at the\nmigration tests first." },
        "Thinking: I need to look at the migration tests first.",
      ],
      ["reasoning", { text: "" }, "Thinking"],
    ];
    cases.forEach(([type, payload, want], i) => {
      t3.item("a", 10 + i, type, payload, `2026-11-25T10:00:${String(i).padStart(2, "0")}.000Z`);
      expect(line("a"), type).toEqual({
        text: want,
        at: `2026-11-25T10:00:${String(i).padStart(2, "0")}.000Z`,
      });
    });
  });

  it("clips long thinking to about 80 characters and picks the highest ordinal across runs", () => {
    t3.thread("a");
    t3.item("a", 2_000_001, "reasoning", { text: "z".repeat(300) });
    t3.item("a", 1_000_050, "command_execution", { input: "older" });
    const text = line("a")?.text as string;
    expect(text.startsWith("Thinking: zzz")).toBe(true);
    expect(text.length).toBeLessThanOrEqual("Thinking: ".length + 80);
    expect(text.endsWith("…")).toBe(true);
  });

  it("skips items that are not steps, and other threads' steps", () => {
    t3.thread("a").thread("b");
    t3.item("a", 5, "command_execution", { input: "ls" });
    t3.item("a", 6, "assistant_message", { text: "All done." });
    t3.item("a", 7, "checkpoint", {});
    t3.item("b", 8, "command_execution", { input: "other thread" });
    expect(line("a")?.text).toBe("$ ls");
  });

  it("survives a broken payload", () => {
    t3.thread("a");
    t3.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_turn_items
           (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
         VALUES ('bad', 'a', 1, 'command_execution', 'running', '2026-11-25T09:00:00.000Z', '{oops')`,
      )
      .run();
    expect(line("a")?.text).toBe("Running a command");
  });

  it("the sync stores a step only when it changed, and keeps the last one after the run", () => {
    t3.thread("a");
    const th = attach("a");
    t3.run("a", 1, "running");
    t3.item("a", 1_000_001, "command_execution", { input: "make" }, "2026-11-25T10:00:00.000Z");
    provider.sync();
    expect(thread("a")).toMatchObject({
      activityText: "$ make",
      activityAt: "2026-11-25T10:00:00.000Z",
    });

    // Nothing new: the stored row is not rewritten (a spy on the writer would see no call).
    const calls: unknown[][] = [];
    const real = ax.setThreadActivity.bind(ax);
    ax.setThreadActivity = (...args) => {
      calls.push(args);
      real(...args);
    };
    provider.sync();
    expect(calls).toHaveLength(0);

    t3.item(
      "a",
      1_000_002,
      "dynamic_tool",
      { toolName: "Read", input: { file_path: "/a/b.ts" } },
      "2026-11-25T10:00:05.000Z",
    );
    provider.sync();
    expect(calls).toEqual([[th.id, "Reading b.ts", "2026-11-25T10:00:05.000Z"]]);

    // A step older than the one a hook stored does not override it.
    ax.setThreadActivity(th.id, "$ from the hook", "2026-11-25T10:00:09.000Z");
    provider.sync();
    expect(thread("a")?.activityText).toBe("$ from the hook");

    // The run ends: the last step stays.
    t3.run("a", 1, "completed");
    provider.sync();
    expect(topicStatus("a")).toBe("idle");
    expect(thread("a")?.activityText).toBe("$ from the hook");
  });

  it("does not touch an ended thread", () => {
    t3.thread("a");
    const th = attach("a");
    ax.threadEnded(th.id, "done");
    t3.item("a", 1, "command_execution", { input: "late" });
    provider.sync();
    expect(thread("a")?.activityText).toBeNull();
  });
});

describe("model, effort and context", () => {
  const runtime = (id: string) => {
    const db = T3Db.open(t3.dir);
    try {
      return db.thread(id, null)?.runtime ?? null;
    } finally {
      db.close();
    }
  };
  const stored = (id: string) => {
    const t = thread(id);
    return {
      model: t?.model,
      effort: t?.effort,
      used: t?.contextUsed,
      max: t?.contextMax,
    };
  };

  it("says nothing for a thread that names no model and has no usage", () => {
    t3.thread("a");
    expect(runtime("a")).toBeNull();
  });

  it("reads the model, either effort option id, and the newest turn's usage", () => {
    t3.thread("a", { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] });
    t3.turn("a", 1, { usedTokens: 1000, maxTokens: 1_000_000 });
    t3.turn("a", 2, { usedTokens: 190_000, maxTokens: 1_000_000 });
    expect(runtime("a")).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      contextUsed: 190_000,
      contextMax: 1_000_000,
    });
    t3.thread("b", {
      model: "gpt-5.4",
      options: [
        { id: "fast", value: true },
        { id: "reasoningEffort", value: "xhigh" },
      ],
    });
    expect(runtime("b")).toEqual({
      model: "gpt-5.4",
      effort: "xhigh",
      contextUsed: null,
      contextMax: null,
    });
  });

  it("orders turns by start time, skips turns without usage, and tolerates a missing max", () => {
    t3.thread("a");
    t3.turn("a", 2, { startedAt: "2026-11-25T09:00:00.000Z", usedTokens: 50 });
    t3.turn("a", 1, { startedAt: "2026-11-25T10:00:00.000Z", usedTokens: 70, model: "claude-x-1" });
    t3.turn("a", 3, { startedAt: "2026-11-25T11:00:00.000Z", noUsage: true });
    // The thread names no model: the turn's is used.
    expect(runtime("a")).toEqual({
      model: "claude-x-1",
      effort: null,
      contextUsed: 70,
      contextMax: null,
    });
    // Another thread's turns do not leak in.
    t3.thread("b");
    expect(runtime("b")).toBeNull();
  });

  it("survives broken payloads", () => {
    t3.thread("a");
    t3.db
      .prepare(
        "UPDATE orchestration_v2_projection_threads SET payload_json = '{oops' WHERE thread_id = 'a'",
      )
      .run();
    t3.db
      .prepare(
        `INSERT INTO orchestration_v2_projection_provider_turns
           (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
         VALUES ('bad', 'a', 'p', 'n', 1, 'completed', '{oops')`,
      )
      .run();
    expect(runtime("a")).toBeNull();
  });

  it("the sync stores them, and writes again only when something changed", () => {
    t3.thread("a", { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] });
    t3.turn("a", 1, { usedTokens: 190_000, maxTokens: 1_000_000 });
    attach("a");
    const before = ax.listEntries("topic-a").length;
    provider.sync();
    expect(stored("a")).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      used: 190_000,
      max: 1_000_000,
    });
    expect(provider.takeRuntimeChanged()).toBe(true);
    const at = thread("a")?.runtimeAt;
    expect(at).not.toBeNull();

    // Nothing new: no write, no change flag.
    provider.sync();
    expect(thread("a")?.runtimeAt).toBe(at);
    expect(provider.takeRuntimeChanged()).toBe(false);

    // A new turn moves the context; a thread that loses its usage keeps the last numbers.
    t3.turn("a", 2, { usedTokens: 210_000, maxTokens: 1_000_000 });
    provider.sync();
    expect(stored("a").used).toBe(210_000);
    expect(provider.takeRuntimeChanged()).toBe(true);
    expect(ax.listEntries("topic-a")).toHaveLength(before);

    // A model change in T3 follows; a removed thread is left alone.
    t3.db
      .prepare(
        `UPDATE orchestration_v2_projection_threads
         SET payload_json = json_set(payload_json, '$.modelSelection.model', 'claude-sonnet-5-5')
         WHERE thread_id = 'a'`,
      )
      .run();
    provider.sync();
    expect(stored("a").model).toBe("claude-sonnet-5-5");
    t3.remove("a");
    t3.db
      .prepare(
        "UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.modelSelection.model', 'ignored') WHERE thread_id = 'a'",
      )
      .run();
    provider.sync();
    expect(stored("a").model).toBe("claude-sonnet-5-5");
  });
});

describe("the subagent tree", () => {
  const read = (id: string) => {
    const db = T3Db.open(t3.dir);
    try {
      return db.thread(id, null)?.subagents ?? [];
    } finally {
      db.close();
    }
  };
  const stored = (id: string) => {
    const th = thread(id);
    const list = (th && ax.listSubagents().get(th.id)) ?? [];
    return list.map((s) => [s.key, s.status, s.title, s.model, s.progress]);
  };

  it("lists the thread's subagents oldest first, finished ones too, with their status", () => {
    t3.thread("a");
    t3.thread("b");
    t3.subagent("a", "s2", {
      title: "Review",
      model: "claude-opus-5-5",
      startedAt: "2026-11-25T09:05:00.000Z",
    });
    t3.subagent("a", "s1", {
      title: "Explore",
      model: "claude-haiku-5",
      progress: "Reading reader.ts",
      startedAt: "2026-11-25T09:01:00.000Z",
    });
    t3.subagent("b", "other", { title: "Not ours" });
    expect(read("a").map((s) => [s.key, s.status, s.title, s.model, s.progress])).toEqual([
      ["s1", "running", "Explore", "claude-haiku-5", "Reading reader.ts"],
      ["s2", "running", "Review", "claude-opus-5-5", null],
    ]);
    // Any other status without a completion time is still running.
    t3.subagent("b", "queued", { status: "starting", title: "Warm up" });
    expect(read("b").map((s) => [s.key, s.status])).toEqual([
      ["other", "running"],
      ["queued", "running"],
    ]);
  });

  it("maps T3's statuses, stamps the end, and keeps the latest step of a running one only", () => {
    t3.thread("a");
    const done = (status: string, key: string) =>
      t3.subagent("a", key, {
        status,
        progress: "Last step",
        startedAt: "2026-11-25T09:00:00.000Z",
        completedAt: "2026-11-25T09:04:00.000Z",
      });
    done("completed", "c");
    done("failed", "f");
    done("cancelled", "x");
    done("interrupted", "i");
    // A completion time without a terminal status is done as well.
    t3.subagent("a", "stamped", { status: "running", completedAt: "2026-11-25T09:10:00.000Z" });
    t3.subagent("a", "live", { progress: "Working" });
    const by = Object.fromEntries(read("a").map((s) => [s.key, s]));
    expect(
      Object.entries(by)
        .map(([k, s]) => [k, s.status])
        .sort(),
    ).toEqual([
      ["c", "done"],
      ["f", "failed"],
      ["i", "cancelled"],
      ["live", "running"],
      ["stamped", "done"],
      ["x", "cancelled"],
    ]);
    expect(by.c).toMatchObject({ endedAt: "2026-11-25T09:04:00.000Z", progress: null });
    expect(by.live).toMatchObject({ endedAt: null, progress: "Working" });
  });

  it("nests a subagent under the subagent its parent_node_id names, else under the thread", () => {
    t3.thread("a");
    t3.subagent("a", "root", { title: "Root", startedAt: "2026-11-25T09:00:00.000Z" });
    t3.subagent("a", "child", {
      title: "Child",
      parent: "root",
      startedAt: "2026-11-25T09:01:00.000Z",
    });
    t3.subagent("a", "stray", {
      title: "Stray",
      parent: "gone",
      startedAt: "2026-11-25T09:02:00.000Z",
    });
    t3.subagent("a", "self", {
      title: "Self",
      parent: "self",
      startedAt: "2026-11-25T09:03:00.000Z",
    });
    expect(read("a").map((s) => [s.key, s.parentKey])).toEqual([
      ["root", null],
      ["child", "root"],
      ["stray", null],
      ["self", null],
    ]);
  });

  it("shows the newest run's subagents, any still running, and any finished in the last 30 minutes", () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    t3.thread("a");
    t3.run("a", 1, "completed");
    t3.subagent("a", "old-done", { status: "completed", runId: "run-a-1", completedAt: ago(40) });
    t3.subagent("a", "old-live", { runId: "run-a-1" });
    t3.subagent("a", "old-recent", { status: "completed", runId: "run-a-1", completedAt: ago(5) });
    t3.subagent("a", "unattached-done", { status: "failed", runId: null, completedAt: ago(40) });
    // A finished one with no run, done long ago, is not the newest run's: it is left out.
    expect(read("a").map((s) => s.key)).toEqual(["old-done", "old-live", "old-recent"]);
    t3.run("a", 2, "running");
    t3.subagent("a", "new-done", { status: "completed", runId: "run-a-2", completedAt: ago(1) });
    t3.subagent("a", "new-live", { runId: "run-a-2" });
    // The new run: the one done 40 minutes ago leaves; the recent one stays across the turn.
    expect(
      read("a")
        .map((s) => s.key)
        .sort(),
    ).toEqual(["new-done", "new-live", "old-live", "old-recent"]);
  });

  it("survives broken payloads", () => {
    t3.thread("a");
    t3.subagent("a", "s1");
    t3.db
      .prepare(
        "UPDATE orchestration_v2_projection_subagents SET payload_json = '{oops' WHERE subagent_id = 's1'",
      )
      .run();
    expect(read("a")).toEqual([
      expect.objectContaining({ key: "s1", title: null, model: null, progress: null }),
    ]);
  });

  it("the sync follows them: progress updates, a finished one stays, it outlives the run for 30 minutes", () => {
    t3.thread("a");
    attach("a");
    t3.run("a", 1, "running");
    t3.subagent("a", "s1", { title: "Explore", progress: "one", runId: "run-a-1" });
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    t3.subagent("a", "s2", { title: "Review", startedAt: ago(18), runId: "run-a-1" });
    provider.sync();
    expect(stored("a")).toEqual([
      ["s1", "running", "Explore", null, "one"],
      ["s2", "running", "Review", null, null],
    ]);
    expect(provider.takeRuntimeChanged()).toBe(true);
    provider.sync();
    expect(provider.takeRuntimeChanged()).toBe(false);
    const before = ax.listEntries("topic-a").length;

    t3.subagent("a", "s1", { title: "Explore", progress: "two", runId: "run-a-1" });
    provider.sync();
    expect(stored("a")[0]).toEqual(["s1", "running", "Explore", null, "two"]);
    expect(provider.takeRuntimeChanged()).toBe(true);

    const doneAt = ago(1);
    t3.subagent("a", "s2", {
      status: "completed",
      completedAt: doneAt,
      startedAt: ago(18),
      title: "Review",
      runId: "run-a-1",
    });
    provider.sync();
    expect(stored("a").map((r) => [r[0], r[1]])).toEqual([
      ["s1", "running"],
      ["s2", "done"],
    ]);
    const ended = ax.listSubagents().get(thread("a")?.id ?? 0)?.[1];
    expect(ended?.endedAt).toBe(doneAt);
    expect(ax.listEntries("topic-a")).toHaveLength(before);

    // The next run: the recently finished one stays, and leaves once it ended over 30 minutes ago.
    t3.run("a", 2, "running");
    provider.sync();
    expect(stored("a").map((r) => r[0])).toEqual(["s1", "s2"]);
    t3.subagent("a", "s2", {
      status: "completed",
      completedAt: ago(31),
      startedAt: ago(48),
      title: "Review",
      runId: "run-a-1",
    });
    provider.sync();
    expect(stored("a").map((r) => r[0])).toEqual(["s1"]);
  });

  it("a removed thread's running subagents are cancelled when it ends", () => {
    t3.thread("a");
    attach("a");
    t3.subagent("a", "s1");
    provider.sync();
    expect(stored("a")).toHaveLength(1);
    t3.remove("a");
    provider.sync();
    expect(stored("a").map((r) => r[1])).toEqual(["cancelled"]);
  });
});
