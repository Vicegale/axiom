import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "./index.js";
import { T3Fixture } from "./test-t3.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;
const owner: Actor = { kind: "owner" };

let dir: string;
let dbPath: string;
let t3: T3Fixture;
let cli: Axiom;
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-t3srv-"));
  dbPath = join(dir, "axiom.db");
  t3 = new T3Fixture(join(dir, "t3"));
  cli = openDatabase(dbPath);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  cli.close();
  t3.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(t3Dir = t3.dir, t3PollMs = 60_000) {
  server = await startServer({ dbPath, port: 0, webDist: join(dir, "no-web"), t3Dir, t3PollMs });
}
async function get(path: string): Promise<{ status: number; body: Any }> {
  const res = await fetch((server as RunningServer).url + path);
  return { status: res.status, body: await res.json() };
}
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("T3 health in /api/health", () => {
  it("ok when the pin matches", async () => {
    await start();
    const { body } = await get("/api/health");
    expect(body.t3).toMatchObject({
      state: "ok",
      serverVersion: "0.1.11-nightly.20261118.4890",
      migration: 98,
      pinned: { serverVersion: "0.1.11-nightly.20261118.4890", migration: 98 },
    });
    expect(typeof body.t3.lastReadAt).toBe("string");
  });

  it("untested-version when the migration differs, and the server keeps serving", async () => {
    t3.db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'x')").run();
    await start();
    const { status, body } = await get("/api/health");
    expect(status).toBe(200);
    expect(body.t3.state).toBe("untested-version");
    expect(body.t3.migration).toBe(99);
    expect((await get("/api/topics")).status).toBe(200);
    expect((await get("/api/t3/threads?unattached=1")).status).toBe(200);
  });

  it("unavailable when T3 is missing, and the server keeps serving", async () => {
    await start(join(dir, "missing"));
    const { status, body } = await get("/api/health");
    expect(status).toBe(200);
    expect(body.t3.state).toBe("unavailable");
    expect(body.t3.lastReadAt).toBeNull();
    expect((await get("/api/topics")).status).toBe(200);
    const picker = await get("/api/t3/threads?unattached=1");
    expect(picker.status).toBe(503);
    expect(picker.body.error.code).toBe("unavailable");
  });
});

describe("GET /api/t3/threads", () => {
  it("lists unattached threads, newest first, with the picker fields", async () => {
    t3.thread("a", { title: "Alpha", updatedAt: "2026-11-25T09:00:00.000Z" });
    t3.thread("b", { title: "Beta", updatedAt: "2026-11-25T10:00:00.000Z" }).run("b", 1, "running");
    t3.thread("c", { title: "Gamma", updatedAt: "2026-11-25T08:00:00.000Z" });
    cli.createTopic({ slug: "demo", title: "Demo" }, owner);
    cli.attachThread("demo", { provider: "t3", providerThreadId: "c" }, owner);
    await start();
    const { status, body } = await get("/api/t3/threads?unattached=1");
    expect(status).toBe(200);
    expect(body).toEqual([
      {
        id: "b",
        title: "Beta",
        environmentId: "env-test",
        status: "running",
        updatedAt: "2026-11-25T10:00:00.000Z",
      },
      {
        id: "a",
        title: "Alpha",
        environmentId: "env-test",
        status: "idle",
        updatedAt: "2026-11-25T09:00:00.000Z",
      },
    ]);
    expect((await get("/api/t3/threads")).body).toHaveLength(3);
  });

  it("returns at most 50", async () => {
    for (let i = 0; i < 60; i++) t3.thread(`t${i}`);
    await start();
    expect((await get("/api/t3/threads?unattached=1")).body).toHaveLength(50);
  });
});

describe("sync loop in the server", () => {
  it("syncs on the interval", async () => {
    t3.thread("a").run("a", 1, "running");
    cli.createTopic({ slug: "demo", title: "Demo" }, owner);
    cli.attachThread("demo", { provider: "t3", providerThreadId: "a" }, owner);
    await start(t3.dir, 50);
    await until(() => cli.getTopic("demo").status === "wip");
    t3.run("a", 1, "completed");
    await until(() => cli.getTopic("demo").status === "idle");
  });

  it("syncs at once when a hook requests a refresh (long interval)", async () => {
    t3.thread("a");
    cli.createTopic({ slug: "demo", title: "Demo" }, owner);
    cli.attachThread("demo", { provider: "t3", providerThreadId: "a" }, owner);
    await start(t3.dir, 60_000);
    expect(cli.getTopic("demo").status).toBe("idle");
    t3.run("a", 1, "running");
    cli.requestProviderRefresh("t3"); // what `axiom hook` does
    await until(() => cli.getTopic("demo").status === "wip");
  });

  it("does not replay events after a restart", async () => {
    t3.thread("a").run("a", 1, "running");
    cli.createTopic({ slug: "demo", title: "Demo" }, owner);
    cli.attachThread("demo", { provider: "t3", providerThreadId: "a" }, owner);
    await start();
    const count = () => cli.listEntries("demo").filter((e) => e.kind === "thread event").length;
    expect(count()).toBe(1);
    await server?.close();
    await start();
    expect(count()).toBe(1);
  });
});
