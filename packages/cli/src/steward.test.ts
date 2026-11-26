// biome-ignore-all lint/suspicious/noExplicitAny: JSON output is checked structurally
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Axiom, openDatabase } from "@axiom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const owner = { kind: "owner" } as const;
const steward = { kind: "steward" } as const;
const AGENT = { AXIOM_ACTOR: "agent" };
const OWNER = { AXIOM_ACTOR: "owner" };

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-cli-steward-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A temporary database with topic `t`; `seed` writes to it directly before the CLI runs. */
function session(seed?: (ax: Axiom) => void) {
  const db = join(dir, `db-${n++}.sqlite`);
  const ax = openDatabase(db);
  ax.createTopic({ slug: "t", title: "Topic T" }, owner);
  seed?.(ax);
  ax.close();
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
  const exec = (args: string[], who: Record<string, string> = OWNER) => {
    const r = spawnSync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", entry, "--db", db, ...args],
      { encoding: "utf8", env: { ...env, ...who } },
    );
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const ok = (args: string[], who: Record<string, string> = OWNER) => {
    const r = exec(args, who);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    return r.out;
  };
  const json = <T = any>(args: string[], who: Record<string, string> = OWNER): T =>
    JSON.parse(ok(["--json", ...args], who)) as T;
  const peek = <T>(fn: (ax: Axiom) => T): T => {
    const a = openDatabase(db);
    try {
      return fn(a);
    } finally {
      a.close();
    }
  };
  return { exec, ok, json, peek };
}

const seeded = () =>
  session((ax) => {
    ax.createTopic({ slug: "u", title: "Topic U" }, owner);
    ax.recordStewardFinding(
      { topic: "t", level: "urgent", title: "Prod is down", body: "500s since 9:00" },
      steward,
    );
    ax.recordStewardFinding({ topic: "u", level: "info", title: "FYI" }, steward);
    ax.addStewardItem({ kind: "question", topic: "t", title: "Keep the flag?" }, steward);
    const f = ax.recordStewardFinding({ topic: "t", level: "attention", title: "CI red" }, steward);
    ax.addStewardFix(
      f.id,
      {
        title: "Fix CI",
        repository: "/r",
        branch: "steward/fix-ci",
        base: "main",
        worktree: "/w",
        complexity: "simple",
        diffstat: "1 file",
        tests: "pass",
      },
      steward,
    );
    ax.addStewardMemory({ scope: "core", text: "The owner is Vicenzo." }, owner);
    ax.addStewardMemory(
      { scope: "attached", attachedKind: "topic", attachedKey: "t", text: "T is tricky." },
      owner,
    );
    ax.addStewardMemory(
      { scope: "attached", attachedKind: "topic", attachedKey: "u", text: "U is calm." },
      owner,
    );
    ax.addStewardMemory({ scope: "general", text: "Prefers short briefs." }, owner);
  });

describe("steward status, usage, items and memory (reads, open to agents)", () => {
  it("status: counts, off by default, server not running", () => {
    const s = seeded();
    const st = s.json(["steward", "status"], AGENT);
    expect(st).toMatchObject({
      enabled: false,
      running: false,
      server: { running: false },
      nextWakeAt: null,
      lastWake: null,
      counts: { questions: 1, findings: { urgent: 1, attention: 1, info: 1 }, suggestions: 0 },
      pendingRequests: 0,
    });
    const text = s.ok(["steward", "status"], AGENT);
    expect(text).toContain("Steward:       off");
    expect(text).toContain("Server:        not running");
    expect(text).toContain("1 question, findings 1 urgent / 1 attention / 1 info, 0 suggestions");
  });

  it("status shows the server's beat and next wake while Steward is on", () => {
    const s = session((ax) => {
      ax.setStewardSettings({ enabled: true }, owner);
      ax.setStewardServerBeat(
        { pid: 4242, freshMs: 3_600_000, nextWakeAt: "2030-01-01T10:00:00.000Z" },
        steward,
      );
    });
    const st = s.json(["steward", "status"]);
    expect(st.server).toMatchObject({ running: true, pid: 4242 });
    expect(st.nextWakeAt).toBe("2030-01-01T10:00:00.000Z");
    expect(s.ok(["steward", "status"])).toContain("Next wake:     2030-01-01 10:00");
  });

  it("usage: tokens per family against the caps", () => {
    const s = session();
    const u = s.json<any[]>(["steward", "usage"], AGENT);
    expect(u.map((x) => x.family)).toEqual(expect.arrayContaining(["haiku", "sonnet", "opus"]));
    expect(u[0]).toMatchObject({ used: 0, runs: 0 });
    expect(s.ok(["steward", "usage"], AGENT)).toContain("tokens");
  });

  it("items: open, most pressing first, with the ready fix; filters by topic and kind", () => {
    const s = seeded();
    const all = s.json<any[]>(["steward", "items"], AGENT);
    expect(all.map((i) => i.title)).toEqual(["Prod is down", "CI red", "Keep the flag?", "FYI"]);
    expect(all[1]).toMatchObject({
      kind: "finding",
      level: "attention",
      topic: "t",
      fixBranch: "steward/fix-ci",
    });
    expect(s.json<any[]>(["steward", "items", "--topic", "u"], AGENT).map((i) => i.title)).toEqual([
      "FYI",
    ]);
    expect(s.json<any[]>(["steward", "items", "--kind", "question"], AGENT)).toHaveLength(1);
    const text = s.ok(["steward", "items", "--topic", "t"], AGENT);
    expect(text).toContain("fix ready: steward/fix-ci");
    expect(text).toContain("500s since 9:00");
    expect(s.exec(["steward", "items", "--kind", "bogus"], AGENT).code).toBe(2);
  });

  it("items: --all includes resolved ones", () => {
    const s = seeded();
    const id = s.json<any[]>(["steward", "items", "--kind", "question"])[0].id;
    s.peek((ax) => ax.dismissStewardItem(id, owner));
    expect(s.json<any[]>(["steward", "items", "--kind", "question"])).toHaveLength(0);
    expect(s.json<any[]>(["steward", "items", "--kind", "question", "--all"])[0].state).toBe(
      "dismissed",
    );
    expect(s.exec(["steward", "items", "--topic", "nope"], AGENT).code).toBe(1);
    expect(s.ok(["steward", "items", "--topic", "u", "--kind", "question"], AGENT)).toBe(
      "No Steward items.",
    );
  });

  it("memory: lists, filters by scope, and by topic (core plus attached to it)", () => {
    const s = seeded();
    expect(s.json<any[]>(["steward", "memory"], AGENT)).toHaveLength(4);
    expect(
      s.json<any[]>(["steward", "memory", "--scope", "general"], AGENT).map((m) => m.text),
    ).toEqual(["Prefers short briefs."]);
    expect(s.json<any[]>(["steward", "memory", "--topic", "t"], AGENT).map((m) => m.text)).toEqual([
      "The owner is Vicenzo.",
      "T is tricky.",
    ]);
    expect(s.exec(["steward", "memory", "--topic", "nope"], AGENT).code).toBe(1);
    expect(s.ok(["steward", "memory", "--scope", "attached"], AGENT)).toContain("topic:t");
  });

  it("memory --retired includes retired items", () => {
    const s = seeded();
    const id = s.json<any[]>(["steward", "memory", "--scope", "general"])[0].id;
    s.ok(["steward", "memory", "retire", String(id)]);
    expect(s.json<any[]>(["steward", "memory"])).toHaveLength(3);
    const all = s.json<any[]>(["steward", "memory", "--retired"]);
    expect(all).toHaveLength(4);
    expect(all.find((m) => m.id === id).retiredAt).not.toBeNull();
  });
});

describe("steward commands only the owner may run", () => {
  const refused: string[][] = [
    ["steward", "on"],
    ["steward", "off"],
    ["steward", "run"],
    ["steward", "memory", "add", "x"],
    ["steward", "memory", "edit", "1", "x"],
    ["steward", "memory", "retire", "1"],
    ["steward", "memory", "delete", "1"],
    ["steward", "memory", "restore", "1"],
  ];
  it.each(refused)("refuses an agent: %s %s %s", (...args) => {
    const s = seeded();
    const r = s.exec(args, AGENT);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^axiom: Only the owner can .*; ask them\.$/);
    // nothing changed
    expect(s.peek((ax) => ax.getStewardSettings().enabled)).toBe(false);
    expect(s.peek((ax) => ax.listStewardMemory().length)).toBe(4);
    expect(s.peek((ax) => ax.listStewardRequests().length)).toBe(0);
  });

  it("an agent inside Claude Code is refused without AXIOM_ACTOR", () => {
    const s = seeded();
    expect(s.exec(["steward", "on"], { CLAUDECODE: "1" }).code).toBe(1);
  });

  it("on and off switch Steward, and --json says so", () => {
    const s = session();
    expect(s.json(["steward", "on"])).toEqual({ enabled: true });
    expect(s.json(["steward", "status"]).enabled).toBe(true);
    expect(s.ok(["steward", "off"])).toBe("Steward is off.");
  });

  it("memory add/edit/retire/restore/delete with the owner as the source", () => {
    const s = seeded();
    const m = s.json(["steward", "memory", "add", "Likes tabs", "--scope", "general"]);
    expect(m).toMatchObject({ scope: "general", source: "owner", text: "Likes tabs" });
    const a = s.json(["steward", "memory", "add", "Watch the deploy", "--attach", "topic:t"]);
    expect(a).toMatchObject({
      scope: "attached",
      attachedKind: "topic",
      attachedKey: "t",
      source: "owner",
    });
    expect(s.json(["steward", "memory", "add", "Be brief"])).toMatchObject({ scope: "core" });
    expect(s.json(["steward", "memory", "edit", String(m.id), "Likes spaces"]).text).toBe(
      "Likes spaces",
    );
    expect(s.json(["steward", "memory", "retire", String(m.id)]).retiredAt).not.toBeNull();
    expect(s.json(["steward", "memory", "restore", String(m.id)]).retiredAt).toBeNull();
    expect(s.ok(["steward", "memory", "delete", String(m.id)])).toBe(`Deleted memory #${m.id}.`);
    expect(s.exec(["steward", "memory", "edit", String(m.id), "x"]).code).toBe(1); // gone
  });

  it("memory add validates through core: attach rules, unknown keys, long text", () => {
    const s = seeded();
    expect(s.exec(["steward", "memory", "add", "x", "--scope", "attached"]).code).toBe(2);
    expect(
      s.exec(["steward", "memory", "add", "x", "--scope", "core", "--attach", "topic:t"]).code,
    ).toBe(2);
    expect(s.exec(["steward", "memory", "add", "x", "--attach", "bogus"]).code).toBe(2);
    const r = s.exec(["steward", "memory", "add", "x", "--attach", "topic:nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"nope" is not a topic slug');
    expect(s.exec(["steward", "memory", "add", "x".repeat(2001)]).err).toContain("at most 2000");
    expect(
      s.json(["steward", "memory", "add", "Maya reviews", "--attach", "person:Maya"]).attachedKey,
    ).toBe("Maya");
  });

  it("run writes a request even while Steward is off and says the server is not running", () => {
    const s = session();
    const r = s.json(["steward", "run"]);
    expect(r.request).toMatchObject({ kind: "run", requestedBy: "owner", handledAt: null });
    expect(r.server.running).toBe(false);
    expect(s.ok(["steward", "run"])).toContain("the request waits until it starts");
    expect(s.peek((ax) => ax.listStewardRequests({ pending: true }).length)).toBe(2);
  });
});

describe("steward check", () => {
  it("writes a request for an agent and for the owner", () => {
    const s = session((ax) => {
      ax.setStewardSettings({ enabled: true }, owner);
      ax.createTopic({ slug: "v", title: "V" }, owner);
    });
    const r = s.json(["steward", "check", "t"], AGENT);
    expect(r.request).toMatchObject({ kind: "check", topic: "t", requestedBy: "agent" });
    expect(r.server.running).toBe(false);
    expect(s.ok(["steward", "check", "v"], OWNER)).toContain("the request waits until it starts");
    expect(s.peek((ax) => ax.listStewardRequests().map((x) => x.requestedBy))).toEqual([
      "owner",
      "agent",
    ]);
  });

  it("is refused when Steward is off, the topic is unknown or steward-disabled", () => {
    const off = session();
    const r = off.exec(["steward", "check", "t"], AGENT);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Steward is off");
    const on = session((ax) => {
      ax.setStewardSettings({ enabled: true }, owner);
      ax.setTopicStewardEnabled("t", false, owner);
    });
    expect(on.exec(["steward", "check", "t"], AGENT).err).toContain("switched off for t");
    expect(on.exec(["steward", "check", "nope"], AGENT).code).toBe(1);
    expect(on.exec(["steward", "check"], AGENT).code).toBe(2);
    expect(on.peek((ax) => ax.listStewardRequests().length)).toBe(0);
  });

  it("allows one check per topic every 10 minutes and says when the next is allowed", () => {
    const s = session((ax) => {
      ax.setStewardSettings({ enabled: true }, owner);
      ax.createTopic({ slug: "v", title: "V" }, owner);
    });
    s.ok(["steward", "check", "t"], AGENT);
    const again = s.exec(["steward", "check", "t"], AGENT);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/next one is allowed after \d{4}-\d\d-\d\dT/);
    s.ok(["steward", "check", "v"], AGENT);
  });
});

describe("topic show", () => {
  it("lists the topic's open Steward items, in text and in --json", () => {
    const s = seeded();
    const text = s.ok(["topic", "show", "t"], AGENT);
    expect(text).toContain("Steward\n");
    expect(text).toMatch(/finding urgent {2}Prod is down/);
    expect(text).toMatch(/finding attention {2}CI red {2}\(fix ready: steward\/fix-ci\)/);
    expect(text).toMatch(/question {2}Keep the flag\?/);
    expect(text).not.toContain("FYI");
    const d = s.json(["topic", "show", "t"], AGENT);
    expect(d.steward.map((i: any) => i.title)).toEqual([
      "Prod is down",
      "CI red",
      "Keep the flag?",
    ]);
    expect(d.steward[1].fixBranch).toBe("steward/fix-ci");
  });

  it("has no Steward section when there are no items", () => {
    const s = session();
    expect(s.ok(["topic", "show", "t"])).not.toContain("Steward");
    expect(s.json(["topic", "show", "t"]).steward).toEqual([]);
  });
});
