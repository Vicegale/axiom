// biome-ignore-all lint/suspicious/noExplicitAny: JSON output is checked structurally
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { openDatabase } from "@axiom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const SID = "5f1c2a9e-0000-4000-8000-0123456789ab";

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-hook-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Payload shapes recorded in the 2026-11-25 hook test. */
const payload = (name: string, extra: Record<string, unknown> = {}, sid = SID) =>
  JSON.stringify({ session_id: sid, hook_event_name: name, cwd: "/tmp/work", ...extra });
const SESSION_START = payload("SessionStart", { source: "startup" });
const PROMPT = payload("UserPromptSubmit", { prompt: "do the thing" });
const STOP = payload("Stop", { stop_hook_active: false });
const SESSION_END = payload("SessionEnd", { reason: "other" });
const PERMISSION = payload("Notification", {
  notification_type: "permission_prompt",
  message: "Claude needs your permission to use Bash",
});
const IDLE = payload("Notification", {
  notification_type: "idle_prompt",
  message: "Claude is waiting for your input",
});

function session() {
  const root = join(dir, `s-${n++}`);
  mkdirSync(root);
  const db = join(root, "db.sqlite");
  const state = join(root, "state");
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: state };
  for (const k of [
    "CLAUDECODE",
    "T3CODE_THREAD_ID",
    "CLAUDE_CODE_SESSION_ID",
    "AXIOM_ACTOR",
    "AXIOM_DB",
  ]) {
    delete env[k];
  }
  const exec = (args: string[], input?: string, more: Record<string, string> = {}, dbPath = db) => {
    const r = spawnSync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", entry, "--db", dbPath, ...args],
      { encoding: "utf8", input: input ?? "", env: { ...env, ...more } },
    );
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (args: string[]): any => JSON.parse(exec(["--json", ...args]).out);
  const hook = (event: string, input: string, more: Record<string, string> = {}) => {
    const r = exec(["hook", event], input, more);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    return r;
  };
  const log = () => {
    const p = join(state, "axiom", "hook.log");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const attach = (id = SID) => {
    exec(["topic", "new", "demo", "--title", "Demo"]);
    const r = exec(["thread", "attach", "demo", "--provider", "claude-code", "--id", id]);
    expect(r.code).toBe(0);
  };
  const notifications = (): string[] => {
    const ax = openDatabase(db);
    try {
      return ax.listNotifications().map((x) => x.kind);
    } finally {
      ax.close();
    }
  };
  const topic = () => json(["topic", "show", "demo"]);
  return { root, db, state, notifications, exec, json, hook, log, attach, topic };
}

describe("axiom hook", () => {
  it("moves an attached topic idle -> wip -> idle with an `agent stopped` notification", () => {
    const s = session();
    s.attach();
    expect(s.topic().status).toBe("idle");
    s.hook("session-start", SESSION_START);
    s.hook("prompt", PROMPT);
    expect(s.topic().status).toBe("wip");
    s.hook("stop", STOP);
    const t = s.topic();
    expect(t.status).toBe("idle");
    expect(s.notifications()).toEqual(["agent stopped"]);
    expect(t.history.map((e: any) => e.body)).toContain("Thread stopped");
    expect(s.log()).toBe("");
  });

  it("a permission notification makes the topic hitl, and stop keeps it hitl", () => {
    const s = session();
    s.attach();
    s.hook("prompt", PROMPT);
    s.hook("notification", PERMISSION);
    expect(s.topic().status).toBe("hitl");
    s.hook("stop", STOP);
    expect(s.topic().status).toBe("hitl");
  });

  it("treats a notification without a type as a permission request only if it mentions permission", () => {
    const s = session();
    s.attach();
    s.hook("prompt", PROMPT);
    s.hook(
      "notification",
      payload("Notification", { message: "Claude is waiting for your input" }),
    );
    expect(s.topic().status).toBe("wip");
    s.hook(
      "notification",
      payload("Notification", { message: "Claude needs your permission to use Edit" }),
    );
    expect(s.topic().status).toBe("hitl");
  });

  it("ignores idle_prompt notifications", () => {
    const s = session();
    s.attach();
    s.hook("prompt", PROMPT);
    s.hook("stop", STOP);
    s.hook("notification", IDLE);
    expect(s.topic().status).toBe("idle");
    expect(s.notifications()).toEqual(["agent stopped"]);
  });

  it("session-end ends the thread and a later session-start reopens it", () => {
    const s = session();
    s.attach();
    s.hook("prompt", PROMPT);
    s.hook("stop", STOP);
    s.hook("session-end", SESSION_END);
    let th = s.topic().threads[0];
    expect(th.endedAt).not.toBeNull();
    expect(th.endReason).toBe("other");
    s.hook("session-start", payload("SessionStart", { source: "resume" }));
    th = s.topic().threads[0];
    expect(th.endedAt).toBeNull();
    expect(s.topic().history.map((e: any) => e.body)).toContain("Thread resumed");
  });

  it("falls back to CLAUDE_CODE_SESSION_ID when the payload has no session_id", () => {
    const s = session();
    s.attach();
    s.hook("prompt", JSON.stringify({ hook_event_name: "UserPromptSubmit" }), {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(s.topic().status).toBe("wip");
  });

  it("does nothing for a session that is not attached", () => {
    const s = session();
    s.attach();
    const before = s.topic().history.length;
    s.hook("prompt", payload("UserPromptSubmit", {}, "some-other-session"));
    s.hook("stop", payload("Stop", {}, "some-other-session"));
    expect(s.topic().status).toBe("idle");
    expect(s.topic().history).toHaveLength(before);
    expect(s.notifications()).toEqual([]);
    expect(s.log()).toBe("");
  });

  it("a stop while subagents still run keeps the thread wip; the next stop without them stops", () => {
    const s = session();
    s.attach();
    s.hook("prompt", PROMPT);
    const waiting = payload("Stop", {
      background_tasks: [
        { id: "a1", type: "subagent", status: "running", agent_type: "general-purpose" },
        { id: "b1", type: "shell", status: "running", command: "npm run dev" },
      ],
    });
    s.hook("stop", waiting);
    expect(s.topic().status).toBe("wip");
    expect(s.notifications()).toEqual([]);
    s.hook("prompt", PROMPT); // re-invoked when the subagent finished
    const onlyShell = payload("Stop", {
      background_tasks: [{ id: "b1", type: "shell", status: "running", command: "npm run dev" }],
    });
    s.hook("stop", onlyShell);
    expect(s.topic().status).toBe("idle");
    expect(s.notifications()).toContain("agent stopped");
  });

  it("inside an attached T3 session, a stop with running subagents is recorded and keeps it wip", () => {
    const s = session();
    s.exec(["topic", "new", "demo", "--title", "Demo"]);
    s.exec(["thread", "attach", "demo", "--provider", "t3", "--id", "t3-sub"]);
    const t3 = { T3CODE_THREAD_ID: "t3-sub" };
    const waiting = payload("Stop", {
      background_tasks: [{ id: "a1", type: "subagent", status: "running" }],
    });
    s.hook("stop", waiting, t3);
    const ax = openDatabase(s.db);
    try {
      const th = ax.findThread({ provider: "t3", providerThreadId: "t3-sub" });
      expect(th && ax.runningSubagents(th.id)).toBe(1);
      expect(s.topic().status).toBe("wip"); // restored even though nothing set it before
    } finally {
      ax.close();
    }
    s.hook("stop", STOP, t3);
    const ax2 = openDatabase(s.db);
    try {
      const th = ax2.findThread({ provider: "t3", providerThreadId: "t3-sub" });
      expect(th && ax2.runningSubagents(th.id)).toBe(0);
    } finally {
      ax2.close();
    }
  });

  it("does nothing inside a T3 session (T3CODE_THREAD_ID set)", () => {
    const s = session();
    s.attach();
    s.hook("prompt", PROMPT, { T3CODE_THREAD_ID: "t3-thread-1" });
    expect(s.topic().status).toBe("idle");
    expect(s.log()).toBe("");
  });

  it("records a refresh request when the T3 thread is attached, and nothing when it is not", () => {
    const s = session();
    s.exec(["topic", "new", "demo", "--title", "Demo"]);
    const refresh = () => {
      const ax = openDatabase(s.db);
      try {
        return ax.providerRefreshRequestedAt("t3");
      } finally {
        ax.close();
      }
    };
    s.hook("prompt", PROMPT, { T3CODE_THREAD_ID: "t3-thread-1" });
    expect(refresh()).toBe(0); // not attached
    expect(s.topic().status).toBe("idle");

    expect(
      s.exec(["thread", "attach", "demo", "--provider", "t3", "--id", "t3-thread-1"]).code,
    ).toBe(0);
    const before = Date.now();
    s.hook("stop", STOP, { T3CODE_THREAD_ID: "t3-thread-1" });
    expect(refresh()).toBeGreaterThanOrEqual(before - 1000);
    expect(s.topic().status).toBe("idle"); // the hook itself records no thread event
    expect(s.log()).toBe("");
  });

  it("exits 0 with a log line on broken stdin, an empty payload and an unknown event", () => {
    const s = session();
    s.attach();
    s.hook("prompt", "{not json");
    s.hook("prompt", "");
    s.hook("prompt", "[]");
    s.hook("prompt", JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
    s.hook("bogus", PROMPT);
    const lines = s.log().trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z prompt /);
    expect(lines[4]).toMatch(/ bogus unknown hook event/);
    expect(s.topic().status).toBe("idle");
  });

  it("exits 0 with a log line when the database cannot be opened", () => {
    const s = session();
    const locked = join(s.root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const r = s.exec(["hook", "prompt"], PROMPT, {}, join(locked, "sub", "db.sqlite"));
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      if (process.getuid?.() !== 0) expect(s.log()).toMatch(/ prompt /);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe("axiom hooks install / uninstall", () => {
  const CLI = "/opt/axiom/packages/cli/dist/index.js";
  const base = (s: string) => ["hooks", s, "--cli-entry", CLI];
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const existing = {
    model: "opus",
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
    },
  };

  function setup(content?: unknown) {
    const s = session();
    const settings = join(s.root, "claude", "settings.json");
    if (content !== undefined) {
      mkdirSync(join(s.root, "claude"), { recursive: true });
      writeFileSync(settings, JSON.stringify(content, null, 2));
    }
    const backups = () =>
      existsSync(join(s.root, "claude"))
        ? readdirSync(join(s.root, "claude")).filter((f) => f.includes(".axiom-backup-"))
        : [];
    return { ...s, settings, backups };
  }
  const events = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];
  const axiomCmds = (h: any, name: string): string[] =>
    (h[name] ?? [])
      .flatMap((g: any) => g.hooks.map((x: any) => x.command))
      .filter((c: string) => / hook [a-z-]+$/.test(c) && c.includes(CLI));

  // `node` here is process.execPath, so assert on the shape rather than the literal path.
  it("creates the file when missing, with a quoted command per event", () => {
    const s = setup();
    const r = s.exec([...base("install"), "--settings", s.settings]);
    expect(r.code).toBe(0);
    const cfg = read(s.settings);
    for (const [name, ev] of [
      ["SessionStart", "session-start"],
      ["UserPromptSubmit", "prompt"],
      ["Notification", "notification"],
      ["Stop", "stop"],
      ["SessionEnd", "session-end"],
    ] as const) {
      expect(cfg.hooks[name]).toEqual([
        { hooks: [{ type: "command", command: `"${process.execPath}" "${CLI}" hook ${ev}` }] },
      ]);
    }
    expect(s.backups()).toHaveLength(0); // nothing to back up
  });

  it("preserves other keys and hooks, backs up the old file, and is idempotent", () => {
    const s = setup(existing);
    const original = readFileSync(s.settings, "utf8");
    expect(s.exec([...base("install"), "--settings", s.settings]).code).toBe(0);
    const cfg = read(s.settings);
    expect(cfg.model).toBe("opus");
    expect(cfg.permissions).toEqual(existing.permissions);
    expect(cfg.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(cfg.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(cfg.hooks.Stop).toHaveLength(2);
    for (const e of events) expect(axiomCmds(cfg.hooks, e)).toHaveLength(1);
    const backups = s.backups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^settings\.json\.axiom-backup-\d{14}$/);
    expect(readFileSync(join(s.root, "claude", backups[0] as string), "utf8")).toBe(original);

    const after = readFileSync(s.settings, "utf8");
    const again = s.exec([...base("install"), "--settings", s.settings]);
    expect(again.code).toBe(0);
    expect(readFileSync(s.settings, "utf8")).toBe(after);
    expect(s.backups()).toHaveLength(1);
  });

  it("--dry-run prints the result and writes nothing", () => {
    const s = setup(existing);
    const original = readFileSync(s.settings, "utf8");
    const r = s.exec([...base("install"), "--settings", s.settings, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hooks.SessionEnd).toBeDefined();
    expect(readFileSync(s.settings, "utf8")).toBe(original);
    expect(s.backups()).toHaveLength(0);
    const fresh = setup();
    fresh.exec([...base("install"), "--settings", fresh.settings, "--dry-run"]);
    expect(existsSync(fresh.settings)).toBe(false);
  });

  it("uninstall removes only Axiom's entries and drops what it leaves empty", () => {
    const s = setup(existing);
    s.exec([...base("install"), "--settings", s.settings]);
    expect(s.exec([...base("uninstall"), "--settings", s.settings]).code).toBe(0);
    expect(read(s.settings)).toEqual(existing);
  });

  it("uninstall from an install-only file removes the hooks key entirely", () => {
    const s = setup({ model: "opus" });
    s.exec([...base("install"), "--settings", s.settings]);
    s.exec([...base("uninstall"), "--settings", s.settings]);
    expect(read(s.settings)).toEqual({ model: "opus" });
  });

  it("updates an Axiom entry whose install location changed instead of adding a second", () => {
    const s = setup();
    s.exec([...base("install"), "--settings", s.settings]);
    s.exec([
      "hooks",
      "install",
      "--cli-entry",
      "/new/place/packages/cli/dist/index.js",
      "--settings",
      s.settings,
    ]);
    const cfg = read(s.settings);
    for (const e of events) expect(cfg.hooks[e]).toHaveLength(1);
    expect(cfg.hooks.Stop[0].hooks[0].command).toContain("/new/place/");
  });

  it("fails with exit 1 and leaves the file alone when it is not valid JSON", () => {
    const s = setup();
    mkdirSync(join(s.root, "claude"), { recursive: true });
    writeFileSync(s.settings, "{oops");
    expect(s.exec([...base("install"), "--settings", s.settings]).code).toBe(1);
    expect(readFileSync(s.settings, "utf8")).toBe("{oops");
  });
});
