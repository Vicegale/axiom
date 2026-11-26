import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorProbe } from "./connectors.js";
import { Steward } from "./scheduler.js";
import { envelope, fakeClaude, fakeGh } from "./test-fakes.js";

const owner = { kind: "owner" } as const;
const agent = { kind: "agent" } as const;

const GATHER = { summary: "Quiet.", activity: [], unreadable: [] };

let dir: string;
let ax: Axiom;
const now = () => new Date(2026, 10, 25, 10);

function setup() {
  const claude = fakeClaude(dir, envelope(GATHER));
  const gh = fakeGh(dir, [
    { match: "api user", stdout: "me\n" },
    { match: "search prs", stdout: [] },
  ]);
  const s = new Steward({
    ax,
    claudeCli: claude.path,
    ghCli: gh.path,
    now,
    tickMs: 0,
    connectors: new ConnectorProbe({
      cli: () => "claude",
      probe: async () => ({ ok: true, servers: [], at: Date.now() }),
    }),
  });
  return { claude, s };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-cli-req-"));
  ax = openDatabase(":memory:", { now });
  ax.createTopic({ slug: "alpha", title: "Alpha" }, owner);
});
afterEach(() => {
  ax.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("requests from the CLI", () => {
  it("runs a check as an event wake on its topic and marks the request handled", async () => {
    ax.setStewardSettings({ enabled: true }, owner);
    const { claude, s } = setup();
    const r = ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent);
    s.pickUpRequests();
    expect(ax.listStewardRequests({ pending: true })).toEqual([]);
    await s.settle();
    const wake = ax.listStewardWakes().find((w) => w.trigger === "event");
    expect(wake?.triggerDetail).toBe("asked by an agent: check alpha");
    expect(claude.runs()).toBeGreaterThan(0);
    const done = ax.listStewardRequests().find((x) => x.id === r.id);
    expect(done?.handledAt).not.toBeNull();
    expect(done?.result).toMatch(/^wake #\d+ done$/);
  });

  it("runs an owner's run request as a forced owner wake, even while Steward is off", async () => {
    const { s } = setup();
    expect(ax.getStewardSettings().enabled).toBe(false);
    const r = ax.requestStewardWake({ kind: "run" }, owner);
    s.pickUpRequests();
    await s.settle();
    expect(ax.listStewardWakes().map((w) => w.trigger)).toContain("owner");
    expect(ax.listStewardRequests().find((x) => x.id === r.id)?.result).toMatch(/^wake #\d+/);
  });

  it("notes when no wake ran because Steward was switched off after the request", async () => {
    ax.setStewardSettings({ enabled: true }, owner);
    const { s } = setup();
    const r = ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent);
    ax.setStewardSettings({ enabled: false }, owner);
    s.pickUpRequests();
    await s.settle();
    expect(ax.listStewardWakes()).toEqual([]);
    expect(ax.listStewardRequests().find((x) => x.id === r.id)?.result).toMatch(/no wake ran/);
  });

  it("picks requests up on a tick, writes the server beat, and clears it on stop", async () => {
    ax.setStewardSettings({ enabled: true }, owner);
    const { s } = setup();
    ax.requestStewardWake({ kind: "check", topic: "alpha" }, owner);
    await s.tick();
    await s.settle();
    expect(ax.listStewardRequests({ pending: true })).toEqual([]);
    expect(ax.getStewardServerBeat()).toMatchObject({ pid: process.pid });
    s.stop();
    expect(ax.getStewardServerBeat()).toBeNull();
  });

  it("skips a check for a topic Steward was switched off for after the request", () => {
    ax.setStewardSettings({ enabled: true }, owner);
    const { claude, s } = setup();
    const r = ax.requestStewardWake({ kind: "check", topic: "alpha" }, agent);
    ax.setTopicStewardEnabled("alpha", false, owner);
    s.pickUpRequests();
    expect(claude.runs()).toBe(0);
    expect(ax.listStewardRequests().find((x) => x.id === r.id)?.result).toMatch(/^not run/);
  });
});
