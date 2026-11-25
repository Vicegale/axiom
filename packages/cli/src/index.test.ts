// biome-ignore-all lint/suspicious/noExplicitAny: JSON output is checked structurally
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AXIOM_VERSION } from "@axiom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-cli-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Result {
  code: number | null;
  out: string;
  err: string;
}

/** One temporary database per test. Our own session variables are scrubbed from the env. */
function session(extraEnv: Record<string, string> = {}) {
  const db = join(dir, `db-${n++}.sqlite`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    "CLAUDECODE",
    "T3CODE_THREAD_ID",
    "CLAUDE_CODE_SESSION_ID",
    "AXIOM_ACTOR",
    "AXIOM_DB",
  ]) {
    delete env[k];
  }
  const exec = (args: string[], more: Record<string, string> = {}): Result => {
    const r = spawnSync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", entry, "--db", db, ...args],
      { encoding: "utf8", env: { ...env, ...extraEnv, ...more } },
    );
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const ok = (args: string[], more: Record<string, string> = {}): string => {
    const r = exec(args, more);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    return r.out;
  };
  const json = <T = any>(args: string[], more: Record<string, string> = {}): T =>
    JSON.parse(ok(["--json", ...args], more)) as T;
  return { exec, ok, json };
}

describe("basics", () => {
  it("prints the core version with --version", () => {
    expect(session().ok(["--version"])).toBe(AXIOM_VERSION);
  });

  it("prints usage with no args", () => {
    expect(session().ok([])).toMatch(/^Usage: axiom/);
  });

  it("exits 2 on unknown commands and bad choices", () => {
    const s = session();
    expect(s.exec(["nonsense"]).code).toBe(2);
    expect(s.exec(["topic", "status", "bogus", "x"]).code).toBe(2);
    expect(s.exec(["topic", "new", "x"]).code).toBe(2); // missing --title
    expect(s.exec(["entry", "bogus", "x", "--topic", "t"]).code).toBe(2);
  });

  it("exits 1 with a message for not-found, in text and in JSON", () => {
    const s = session();
    const r = s.exec(["topic", "show", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe("axiom: topic not found: nope");
    const j = s.exec(["--json", "topic", "show", "nope"]);
    expect(j.code).toBe(1);
    expect(JSON.parse(j.err)).toEqual({
      error: { code: "not-found", message: "topic not found: nope" },
    });
  });
});

describe("topics", () => {
  it("creates, shows, notes, sets goal and status", () => {
    const s = session();
    s.ok(["topic", "new", "alpha", "--title", "Alpha", "--goal", "g1", "--note", "n1"]);
    s.ok(["topic", "note", "n2", "alpha"]);
    s.ok(["topic", "goal", "g2", "alpha"]);
    s.ok(["topic", "status", "blocked", "alpha", "--reason", "waiting for keys"]);
    const text = s.ok(["topic", "show", "alpha"]);
    expect(text).toContain("alpha: Alpha");
    expect(text).toContain("blocked");
    expect(text).toContain("n2");
    expect(text).toContain("goal:        g2");
    expect(text).toContain("idle -> blocked: waiting for keys");
    expect(s.exec(["topic", "new", "alpha", "--title", "again"]).code).toBe(1);
    expect(s.exec(["topic", "new", "Bad Slug", "--title", "x"]).err).toContain("slug");
  });

  it("list hides done and stale by default and filters by view and status", () => {
    const s = session();
    for (const slug of ["a", "b", "c", "d"]) s.ok(["topic", "new", slug, "--title", slug]);
    s.ok(["topic", "status", "done", "a"]);
    s.ok(["topic", "status", "hitl", "b"]);
    s.ok(["topic", "status", "monitoring", "c"]);
    const slugs = (a: string[]) =>
      s
        .json<{ slug: string }[]>(["topic", "list", ...a])
        .map((t) => t.slug)
        .sort();
    expect(slugs([])).toEqual(["b", "c", "d"]);
    expect(slugs(["--all"])).toEqual(["a", "b", "c", "d"]);
    expect(slugs(["--status", "done"])).toEqual(["a"]);
    expect(slugs(["--view", "attention"])).toEqual(["b"]);
    expect(slugs(["--view", "monitoring"])).toEqual(["c"]);
    expect(slugs(["--view", "ongoing"])).toEqual([]);
    expect(s.ok(["topic", "list"])).toMatch(/^\s?b\s+hitl/m);
  });

  it("--json shape for show and list", () => {
    const s = session();
    s.ok(["topic", "new", "alpha", "--title", "Alpha"]);
    const show = s.json(["topic", "show", "alpha"]);
    expect(show).toMatchObject({
      slug: "alpha",
      title: "Alpha",
      status: "idle",
      tickets: [],
      epics: [],
      threads: [],
      links: [],
      monitorTargets: [],
      views: ["piles"],
    });
    expect(show.history).toHaveLength(1);
    expect(show.history[0]).toMatchObject({ kind: "topic created", author: "axiom" });
    const list = s.json(["topic", "list"]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: "alpha", status: "idle", highlighted: false });
  });

  it("show keeps only the last 10 history entries", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    for (let i = 0; i < 12; i++) s.ok(["entry", "note", `n${i}`, "--topic", "t"]);
    const h = s.json(["topic", "show", "t"]).history;
    expect(h).toHaveLength(10);
    expect(h.at(-1).body).toBe("n11");
  });

  it("agents cannot set stale or wip", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    const r = s.exec(["topic", "status", "stale", "t"], { AXIOM_ACTOR: "agent" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^axiom: /);
    s.ok(["topic", "status", "stale", "t"]);
  });
});

describe("tickets, epics and parents", () => {
  it("creates, sets status and lists; Jira-linked status is locked", () => {
    const s = session();
    for (const kind of ["ticket", "epic"]) {
      s.ok([kind, "new", "plain", "--title", "Plain"]);
      s.ok([kind, "status", "plain", "wip"]);
      s.ok([
        kind,
        "new",
        "jira",
        "--title",
        "Jira one",
        "--jira-key",
        "ABC-1",
        "--jira-url",
        "https://j/ABC-1",
      ]);
      const locked = s.exec([kind, "status", "jira", "done"]);
      expect(locked.code).toBe(1);
      expect(locked.err).toContain("Jira");
      const list = s.json<{ slug: string; status: string; jiraKey: string | null }[]>([
        kind,
        "list",
      ]);
      expect(list.map((i) => [i.slug, i.status, i.jiraKey])).toEqual([
        ["plain", "wip", null],
        ["jira", "to do", "ABC-1"],
      ]);
      expect(s.ok([kind, "list"])).toContain("ABC-1");
    }
    expect(s.exec(["ticket", "new", "x", "--title", "x", "--jira-key", "K"]).code).toBe(2);
    expect(s.exec(["ticket", "status", "plain", "finished"]).code).toBe(2);
  });

  it("links tickets to epics and topics to both, on creation and afterwards", () => {
    const s = session();
    s.ok(["epic", "new", "e1", "--title", "E1"]);
    s.ok(["ticket", "new", "t1", "--title", "T1", "--epic", "e1"]);
    s.ok(["topic", "new", "top", "--title", "Top", "--ticket", "t1", "--epic", "e1"]);
    let show = s.json(["topic", "show", "top"]);
    expect(show.tickets.map((t: any) => t.slug)).toEqual(["t1"]);
    expect(show.epics.map((t: any) => t.slug)).toEqual(["e1"]);
    s.ok(["topic", "parent", "remove", "top", "--ticket", "t1"]);
    s.ok(["epic", "new", "e2", "--title", "E2"]);
    s.ok(["topic", "parent", "add", "top", "--epic", "e2"]);
    show = s.json(["topic", "show", "top"]);
    expect(show.tickets).toEqual([]);
    expect(show.epics.map((t: any) => t.slug)).toEqual(["e1", "e2"]);
    expect(s.ok(["topic", "show", "top"])).toContain("epics:       e1, e2");
    expect(s.exec(["topic", "parent", "add", "top"]).code).toBe(2);
    expect(s.exec(["topic", "parent", "add", "top", "--ticket", "nope"]).code).toBe(1);
  });
});

describe("entries", () => {
  it("writes every kind with its data", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    s.ok(["entry", "note", "a note", "--topic", "t"]);
    s.ok(["entry", "decision", "use X", "--topic", "t", "--why", "cheap"]);
    s.ok(["entry", "finding", "it leaks", "--topic", "t"]);
    s.ok([
      "entry",
      "verification",
      "works",
      "--topic",
      "t",
      "--result",
      "partial",
      "--evidence",
      "e1",
      "--evidence",
      "e2",
    ]);
    s.ok(["entry", "next-steps", "do Y", "--topic", "t"]);
    s.ok(["entry", "owner-input", "go ahead", "--topic", "t"]);
    s.ok([
      "entry",
      "authorization",
      "may push",
      "--topic",
      "t",
      "--scope",
      "git push",
      "--standing",
    ]);
    const entries = s.json<any[]>(["entries", "t"]);
    expect(entries.slice(1).map((e) => e.kind)).toEqual([
      "note",
      "decision",
      "finding",
      "verification",
      "next steps",
      "owner input",
      "authorization",
    ]);
    expect(entries[2].data).toEqual({ why: "cheap" });
    expect(entries[4].data).toEqual({ result: "partial", evidence: ["e1", "e2"] });
    expect(entries[7].data).toEqual({ scope: "git push", standing: true });
    expect(
      entries.every((e) => e.author === (e.kind === "topic created" ? "axiom" : "owner")),
    ).toBe(true);
  });

  it("validates data per kind", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    expect(s.exec(["entry", "verification", "x", "--topic", "t"]).code).toBe(1); // needs --result
    expect(s.exec(["entry", "note", "x", "--topic", "t", "--why", "w"]).code).toBe(1);
    expect(s.exec(["entry", "authorization", "x", "--topic", "t"]).code).toBe(1); // needs --scope
    expect(s.exec(["entry", "note", "  ", "--topic", "t"]).code).toBe(1);
  });

  it("rejects owner-only kinds from an agent and records agent as author", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    for (const [kind, extra] of [
      ["owner-input", []],
      ["authorization", ["--scope", "s"]],
    ] as const) {
      const r = s.exec(["entry", kind, "x", "--topic", "t", ...extra], { AXIOM_ACTOR: "agent" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("only by the owner");
    }
    s.ok(["entry", "decision", "agent decided", "--topic", "t"], { AXIOM_ACTOR: "agent" });
    s.ok(["entry", "note", "claude code note", "--topic", "t"], { CLAUDECODE: "1" });
    s.ok(["entry", "note", "t3 note", "--topic", "t"], { T3CODE_THREAD_ID: "x" });
    expect(s.exec(["entry", "owner-input", "x", "--topic", "t"], { CLAUDECODE: "1" }).code).toBe(1);
    // AXIOM_ACTOR=owner wins over the Claude Code marker.
    s.ok(["entry", "owner-input", "fine", "--topic", "t"], {
      CLAUDECODE: "1",
      AXIOM_ACTOR: "owner",
    });
    const authors = s.json<any[]>(["entries", "t", "--kind", "note"]).map((e) => e.author);
    expect(authors).toEqual(["agent", "agent"]);
    expect(s.json<any[]>(["entries", "t", "--kind", "decision"])[0].author).toBe("agent");
    expect(s.json<any[]>(["entries", "t", "--kind", "owner-input"])[0].author).toBe("owner");
  });

  it("stores refs and corrections", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    s.ok(["entry", "finding", "wrong", "--topic", "t"]);
    s.ok([
      "entry",
      "finding",
      "right",
      "--topic",
      "t",
      "--ref",
      "pr:https://x/1",
      "--ref",
      "commit:abc123",
      "--corrects",
      "2",
    ]);
    const [, first, second] = s.json<any[]>(["entries", "t"]);
    expect(first.correctsEntryId).toBeNull();
    expect(second.correctsEntryId).toBe(2);
    expect(second.refs).toEqual([
      { type: "pr", value: "https://x/1" },
      { type: "commit", value: "abc123" },
    ]);
    const text = s.ok(["entries", "t", "--limit", "1"]);
    expect(text).toContain("corrects: #2");
    expect(text).toContain("ref: pr:https://x/1");
    expect(s.exec(["entry", "note", "x", "--topic", "t", "--ref", "nonsense"]).code).toBe(2);
    expect(s.exec(["entry", "note", "x", "--topic", "t", "--ref", "bogus:1"]).code).toBe(1);
    expect(s.exec(["entry", "note", "x", "--topic", "t", "--corrects", "999"]).code).toBe(1);
    expect(s.exec(["entry", "note", "x", "--topic", "t", "--corrects", "abc"]).code).toBe(2);
  });

  it("limits entries", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    for (const b of ["one", "two", "three"]) s.ok(["entry", "note", b, "--topic", "t"]);
    expect(s.json<any[]>(["entries", "t", "--limit", "2"]).map((e) => e.body)).toEqual([
      "two",
      "three",
    ]);
  });
});

describe("links and monitors", () => {
  it("adds links and monitor targets, then confirms", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    s.ok(["link", "add", "repository", "/home/me/repo", "--label", "main repo", "--topic", "t"]);
    s.ok(["link", "add", "pr", "https://github.com/o/r/pull/1", "--topic", "t"]);
    expect(s.exec(["link", "add", "bogus", "x", "--topic", "t"]).code).toBe(2);
    s.ok(["monitor", "add", "pr", "https://github.com/o/r/pull/1", "--topic", "t"]);
    s.ok(["monitor", "add", "branch", "feat/x", "--topic", "t", "--confirmed"]);
    let show = s.json(["topic", "show", "t"]);
    expect(show.links.map((l: any) => [l.kind, l.target])).toEqual([
      ["repository", "/home/me/repo"],
      ["pr", "https://github.com/o/r/pull/1"],
      ["branch", "feat/x"],
    ]);
    expect(show.links[0].label).toBe("main repo");
    expect(show.monitorTargets.map((m: any) => [m.kind, m.state, m.target])).toEqual([
      ["pr", "suggested", "https://github.com/o/r/pull/1"],
      ["branch", "confirmed", "feat/x"],
    ]);
    s.ok(["monitor", "confirm", String(show.monitorTargets[0].id)]);
    show = s.json(["topic", "show", "t"]);
    expect(show.monitorTargets[0].state).toBe("confirmed");
    expect(s.ok(["topic", "show", "t"])).toContain("confirmed  https://github.com/o/r/pull/1");
    expect(s.exec(["monitor", "confirm", "999"]).code).toBe(1);
    expect(s.exec(["monitor", "confirm", "x"]).code).toBe(2);
  });
});

describe("threads", () => {
  it("attaches the claude-code session from CLAUDE_CODE_SESSION_ID and defaults the topic", () => {
    const s = session();
    const env = { CLAUDE_CODE_SESSION_ID: "sess-1" };
    s.ok(["topic", "new", "t", "--title", "T"]);
    // Not attached yet: no default topic.
    const none = s.exec(["topic", "show"], env);
    expect(none.code).toBe(1);
    expect(none.err).toContain("not attached");
    expect(s.json(["thread", "show"], env)).toMatchObject({
      attached: false,
      provider: "claude-code",
    });
    s.ok(["thread", "attach", "t"], env);
    const th = s.json(["thread", "show"], env);
    expect(th).toMatchObject({
      attached: true,
      thread: { provider: "claude-code", providerThreadId: "sess-1" },
      topic: { slug: "t" },
    });
    expect(s.ok(["thread", "show"], env)).toContain("t: T");
    // Defaults.
    s.ok(["entry", "note", "from the thread"], env);
    s.ok(["topic", "note", "default note"], env);
    s.ok(["topic", "goal", "default goal"], env);
    s.ok(["link", "add", "spec", "docs/x.md"], env);
    s.ok(["monitor", "add", "pr", "https://x/pr/1"], env);
    expect(s.ok(["topic", "show"], env)).toContain("default goal");
    expect(s.json<any[]>(["entries"], env).map((e) => e.body)).toContain("from the thread");
    expect(s.exec(["thread", "attach", "t"], env).code).toBe(1); // already attached
  });

  it("attaches T3CODE_THREAD_ID as a t3 thread, ahead of the session id", () => {
    const s = session();
    const env = { T3CODE_THREAD_ID: "t3-thread-9", CLAUDE_CODE_SESSION_ID: "inner" };
    s.ok(["topic", "new", "t", "--title", "T"]);
    s.ok(["thread", "attach", "t"], env);
    const show = s.json(["topic", "show", "t"]);
    expect(show.threads).toHaveLength(1);
    expect(show.threads[0]).toMatchObject({
      provider: "t3",
      providerThreadId: "t3-thread-9",
      environmentId: null,
    });
    expect(s.json(["thread", "show"], env).topic.slug).toBe("t");
  });

  it("records the attached thread on entries written by an agent", () => {
    const s = session();
    const env = { T3CODE_THREAD_ID: "th", CLAUDECODE: "1" };
    s.ok(["topic", "new", "t", "--title", "T"]);
    s.ok(["thread", "attach", "t"], env);
    s.ok(["entry", "decision", "chosen"], env);
    const e = s.json<any[]>(["entries", "t", "--kind", "decision"])[0];
    expect(e.author).toBe("agent");
    expect(e.threadId).toBe(1);
  });

  it("attaches explicitly with --provider/--id/--env/--title", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    s.ok([
      "thread",
      "attach",
      "t",
      "--provider",
      "t3",
      "--id",
      "abc",
      "--env",
      "env-1",
      "--title",
      "My thread",
    ]);
    const th = s.json(["topic", "show", "t"]).threads[0];
    expect(th).toMatchObject({
      provider: "t3",
      providerThreadId: "abc",
      environmentId: "env-1",
      title: "My thread",
    });
    expect(s.ok(["topic", "show", "t"])).toContain("t3:env-1/abc");
  });

  it("usage errors for attach and show", () => {
    const s = session();
    s.ok(["topic", "new", "t", "--title", "T"]);
    expect(s.exec(["thread", "attach", "t"]).code).toBe(2); // no session
    expect(s.exec(["thread", "attach", "t", "--provider", "t3"]).code).toBe(2);
    expect(s.exec(["thread", "attach", "t", "--provider", "other", "--id", "x"]).code).toBe(2);
    expect(s.exec(["thread", "show"]).code).toBe(2);
    expect(s.exec(["thread", "attach", "missing", "--provider", "t3", "--id", "x"]).code).toBe(1);
  });
});
