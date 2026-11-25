import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "./index.js";
import { expandFolder, slugify } from "./newtopic.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;
const owner: Actor = { kind: "owner" };

let dir: string;
let cli: Axiom;
let server: RunningServer;
let oldHome: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "axiom-newtopic-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  const dbPath = join(dir, "axiom.db");
  cli = openDatabase(dbPath);
  server = await startServer({
    dbPath,
    port: 0,
    webDist: join(dir, "no-web"),
    t3Dir: join(dir, "no-t3"),
    claudeCli: "/nonexistent/claude",
    t3Cli: "/nonexistent/t3",
  });
});
afterEach(async () => {
  await server.close();
  cli.close();
  process.env.HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(server.url + path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as Any };
}
const post = (body: unknown) => api("/api/topics", { method: "POST", body });

describe("slugify", () => {
  it("makes lowercase kebab-case", () => {
    expect(slugify("  Fix the Importer!  ")).toBe("fix-the-importer");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("???")).toBe("topic");
  });
});

describe("expandFolder", () => {
  it("expands ~ and rejects relative paths", () => {
    expect(expandFolder("~/x/", "/h")).toBe("/h/x");
    expect(expandFolder("~", "/h")).toBe("/h");
    expect(() => expandFolder("x/y")).toThrow();
  });
});

describe("POST /api/topics", () => {
  it("derives the slug from the title and de-duplicates", async () => {
    const a = await post({ title: "Fix the importer" });
    expect(a.status).toBe(201);
    expect(a.body.slug).toBe("fix-the-importer");
    expect(a.body.title).toBe("Fix the importer");
    expect((await post({ title: "Fix the importer" })).body.slug).toBe("fix-the-importer-2");
    expect((await post({ title: "Fix the importer" })).body.slug).toBe("fix-the-importer-3");
  });

  it("uses an explicit slug, the goal, parents and a repository link", async () => {
    cli.createEpic({ slug: "e1", title: "Epic" }, owner);
    cli.createTicket({ slug: "t1", title: "Ticket" }, owner);
    const r = await post({
      slug: "my-topic",
      title: "Mine",
      goal: " Ship it ",
      epic: "e1",
      ticket: "t1",
      repository: "~/projects/foo/",
    });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe("my-topic");
    expect(r.body.goal).toBe("Ship it");
    expect(r.body.epics.map((e: Any) => e.slug)).toEqual(["e1"]);
    expect(r.body.tickets.map((e: Any) => e.slug)).toEqual(["t1"]);
    expect(r.body.links).toMatchObject([
      { kind: "repository", target: join(process.env.HOME as string, "projects/foo") },
    ]);
    expect(cli.getTopic("my-topic").title).toBe("Mine");
  });

  it("validates", async () => {
    expect((await post({ title: "  " })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ title: "x", slug: "Bad Slug" })).status).toBe(400);
    expect((await post({ title: "x", repository: "relative/dir" })).status).toBe(400);
    expect((await post({ title: "x", bogus: 1 })).status).toBe(400);
    const missing = await post({ title: "x", epic: "nope" });
    expect(missing.status).toBe(404);
    // Nothing was created by the failures.
    expect(cli.listTopics({})).toHaveLength(0);
  });

  it("answers 409 for a duplicate explicit slug", async () => {
    expect((await post({ slug: "dup", title: "A" })).status).toBe(201);
    expect((await post({ slug: "dup", title: "B" })).status).toBe(409);
  });
});

describe("GET /api/workspaces", () => {
  it("lists linked folders first, then git repos under ~/projects", async () => {
    const home = process.env.HOME as string;
    for (const n of ["alpha", "beta"]) {
      mkdirSync(join(home, "projects", n, ".git"), { recursive: true });
    }
    mkdirSync(join(home, "projects", "plain"), { recursive: true });
    writeFileSync(join(home, "projects", "file.txt"), "x");
    cli.createTopic({ slug: "a", title: "A" }, owner);
    cli.addLink("a", { kind: "repository", target: "/srv/old" }, owner);
    cli.addLink("a", { kind: "worktree", target: join(home, "projects/beta") }, owner);
    cli.addLink("a", { kind: "branch", target: "main" }, owner);
    const r = await api("/api/workspaces");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { path: join(home, "projects/beta"), label: "~/projects/beta", source: "axiom" },
      { path: "/srv/old", label: "/srv/old", source: "axiom" },
      { path: join(home, "projects/alpha"), label: "~/projects/alpha", source: "projects" },
    ]);
  });

  it("is empty without links or ~/projects", async () => {
    expect((await api("/api/workspaces")).body).toEqual([]);
  });
});
