import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;
const owner: Actor = { kind: "owner" };

let dir: string;
let repo: string;
let outside: string;
let server: RunningServer;
let cli: Axiom;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "axiom-docs-"));
  repo = join(dir, "repo");
  outside = join(dir, "outside");
  mkdirSync(join(repo, "docs", "adr"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(
    join(repo, "docs", "spec.md"),
    "intro\n\n```\n# not a title\n```\n\n# The Spec\n\ntext\n",
  );
  writeFileSync(join(repo, "docs", "adr", "0001.md"), "no heading here\n");
  writeFileSync(join(repo, "docs", "pic.png"), PNG);
  writeFileSync(join(repo, "docs", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(repo, "docs", "notes.txt"), "plain");
  writeFileSync(join(outside, "secret.md"), "# Secret\n");
  writeFileSync(join(outside, "secret.png"), PNG);
  writeFileSync(join(outside, "named.md"), "# Named\n");
  symlinkSync(join(outside, "secret.md"), join(repo, "docs", "escape.md"));
  symlinkSync(outside, join(repo, "docs", "outlink"));
  server = await startServer({
    dbPath: join(dir, "axiom.db"),
    port: 0,
    webDist: join(dir, "no-web"),
    t3Dir: join(dir, "no-t3"),
  });
  cli = openDatabase(join(dir, "axiom.db"));
  cli.createTopic({ slug: "t", title: "T" }, owner);
  cli.addLink("t", { kind: "repository", target: repo }, owner);
});

afterEach(async () => {
  cli.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string) {
  const res = await fetch(server.url + path);
  const type = res.headers.get("content-type") ?? "";
  const body: Any = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers };
}

function link(kind: "spec" | "artifact" | "worktree" | "repository", target: string): number {
  return cli.addLink("t", { kind, target }, owner).id;
}

const doc = (id: number, path?: string) =>
  get(`/api/topics/t/docs/${id}${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`);
const file = (path: string) => get(`/api/topics/t/files?path=${encodeURIComponent(path)}`);

describe("GET /api/topics/:slug/docs/:linkId", () => {
  it("returns a relative spec link resolved against the repository link", async () => {
    const id = link("spec", "docs/spec.md");
    const r = await doc(id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      linkId: id,
      relPath: "docs/spec.md",
      title: "The Spec",
      root: repo,
    });
    expect(r.body.path).toMatch(/docs\/spec\.md$/);
    expect(r.body.markdown).toContain("text");
    expect(typeof r.body.mtime).toBe("number");
  });

  it("uses an absolute target as is, and falls back to the file name as the title", async () => {
    const id = link("artifact", join(repo, "docs", "adr", "0001.md"));
    const r = await doc(id);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("0001.md");
  });

  it("resolves relative targets against a worktree link when there is no repository link", async () => {
    cli.createTopic({ slug: "w", title: "W" }, owner);
    cli.addLink("w", { kind: "worktree", target: repo }, owner);
    const l = cli.addLink("w", { kind: "spec", target: "docs/spec.md" }, owner);
    const r = await get(`/api/topics/w/docs/${l.id}`);
    expect(r.status).toBe(200);
  });

  it("refuses a relative target when the topic has no repository or worktree", async () => {
    cli.createTopic({ slug: "n", title: "N" }, owner);
    const l = cli.addLink("n", { kind: "spec", target: "docs/spec.md" }, owner);
    expect((await get(`/api/topics/n/docs/${l.id}`)).status).toBe(400);
  });

  it("serves a file named by a spec link even outside the repository", async () => {
    const id = link("spec", join(outside, "named.md"));
    const r = await doc(id);
    expect(r.status).toBe(200);
    expect(r.body.title).toBe("Named");
  });

  it("opens another Markdown file relative to the doc's directory", async () => {
    const id = link("spec", "docs/spec.md");
    const r = await doc(id, "adr/0001.md");
    expect(r.status).toBe(200);
    expect(r.body.relPath).toBe("docs/adr/0001.md");
  });

  it("rejects a .. escape out of the allowed roots", async () => {
    const id = link("spec", "docs/spec.md");
    expect((await doc(id, "../../../outside/secret.md")).status).toBe(403);
    // Also when the file does not exist: still a refusal, not a probe.
    expect((await doc(id, "../../../outside/none.md")).status).toBe(403);
  });

  it("rejects a symlink that points outside the roots", async () => {
    const id = link("spec", "docs/spec.md");
    expect((await doc(id, "escape.md")).status).toBe(403);
    expect((await doc(id, "outlink/secret.md")).status).toBe(403);
  });

  it("does not let a sibling file in an exact-file link's directory through", async () => {
    cli.createTopic({ slug: "f", title: "F" }, owner);
    const l = cli.addLink("f", { kind: "spec", target: join(outside, "named.md") }, owner);
    expect((await get(`/api/topics/f/docs/${l.id}?path=secret.md`)).status).toBe(403);
  });

  it("rejects non-Markdown files and links that are not local Markdown", async () => {
    const id = link("spec", "docs/spec.md");
    expect((await doc(id, "notes.txt")).status).toBe(403);
    expect((await doc(link("spec", "https://example.com/x.md"))).status).toBe(400);
    expect((await doc(link("artifact", "docs/pic.png"))).status).toBe(400);
  });

  it("only serves spec and artifact links", async () => {
    expect((await doc(link("worktree", repo))).status).toBe(400);
  });

  it("404s for a missing file, link or topic", async () => {
    const id = link("spec", "docs/missing.md");
    expect((await doc(id)).status).toBe(404);
    expect((await doc(9999)).status).toBe(404);
    expect((await get("/api/topics/nope/docs/1")).status).toBe(404);
    expect((await doc(link("spec", "docs/spec.md"), "adr/missing.md")).status).toBe(404);
  });

  it("rejects a link id that is not a number", async () => {
    expect((await get("/api/topics/t/docs/abc")).status).toBe(400);
  });

  it("caps the size at 2 MB", async () => {
    writeFileSync(join(repo, "docs", "big.md"), "x".repeat(2 * 1024 * 1024 + 1));
    expect((await doc(link("spec", "docs/big.md"))).status).toBe(413);
  });

  it("does not read a link from another topic", async () => {
    cli.createTopic({ slug: "o", title: "O" }, owner);
    const l = cli.addLink("o", { kind: "spec", target: join(repo, "docs", "spec.md") }, owner);
    expect((await doc(l.id)).status).toBe(404);
  });
});

describe("GET /api/topics/:slug/files", () => {
  it("serves images by absolute or root-relative path", async () => {
    const a = await file(join(repo, "docs", "pic.png"));
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("image/png");
    expect(a.body.equals(PNG)).toBe(true);
    expect((await file("docs/pic.png")).status).toBe(200);
  });

  it("serves SVG sandboxed", async () => {
    const r = await file("docs/pic.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects files outside the roots, by .. and by symlink", async () => {
    expect((await file(join(outside, "secret.png"))).status).toBe(403);
    expect((await file("docs/../../outside/secret.png")).status).toBe(403);
    expect((await file("docs/outlink/secret.png")).status).toBe(403);
  });

  it("rejects other types, missing files, oversize files and a missing path", async () => {
    expect((await file("docs/notes.txt")).status).toBe(403);
    expect((await file("docs/spec.md")).status).toBe(403);
    expect((await file("docs/none.png")).status).toBe(404);
    writeFileSync(join(repo, "docs", "big.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect((await file("docs/big.png")).status).toBe(413);
    expect((await get("/api/topics/t/files")).status).toBe(400);
  });

  it("expands ~ to the home directory", async () => {
    const r = await file("~/.axiom-test-nonexistent/x.png");
    expect(r.status).toBe(403);
  });
});
