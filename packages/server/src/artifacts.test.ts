import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;
const owner: Actor = { kind: "owner" };
const CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads";

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
  dir = mkdtempSync(join(tmpdir(), "axiom-art-"));
  repo = join(dir, "repo");
  outside = join(dir, "outside");
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repo, "docs", "page.html"), "<html><body>hi</body></html>");
  writeFileSync(join(repo, "docs", "old.htm"), "<p>old</p>");
  writeFileSync(join(repo, "docs", "pic.png"), PNG);
  writeFileSync(join(repo, "docs", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(repo, "docs", "app.js"), "alert(1)");
  writeFileSync(join(repo, "docs", "spec.md"), "# Spec\n");
  writeFileSync(join(outside, "secret.html"), "<p>secret</p>");
  writeFileSync(join(outside, "named.html"), "<p>named</p>");
  symlinkSync(join(outside, "secret.html"), join(repo, "docs", "escape.html"));
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

function art(target: string, label?: string, kind: "artifact" | "spec" = "artifact"): number {
  return cli.addLink("t", { kind, target, ...(label ? { label } : {}) }, owner).id;
}
const raw = (id: number) => get(`/api/topics/t/artifacts/${id}/raw`);
const meta = (id: number) => get(`/api/topics/t/artifacts/${id}`);

describe("GET /api/topics/:slug/artifacts/:linkId/raw", () => {
  it("serves HTML inside the sandbox CSP with nosniff and no-store", async () => {
    const r = await raw(art("docs/page.html"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.toString()).toContain("hi");
    expect((await raw(art("docs/old.htm"))).headers.get("content-security-policy")).toBe(CSP);
  });

  it("serves images, and SVG fully sandboxed", async () => {
    const png = await raw(art("docs/pic.png"));
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.headers.get("cache-control")).toBe("no-store");
    expect(png.body.equals(PNG)).toBe(true);
    const svg = await raw(art("docs/pic.svg"));
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("serves a file named by an absolute link even outside the repository", async () => {
    const r = await raw(art(join(outside, "named.html")));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
  });

  it("refuses a relative link that escapes by symlink or ..", async () => {
    expect((await raw(art("docs/escape.html"))).status).toBe(403);
    expect((await meta(art("docs/escape.html"))).status).toBe(403);
    expect((await raw(art("../outside/secret.html"))).status).toBe(403);
    expect((await raw(art("docs/../../outside/named.html"))).status).toBe(403);
  });

  it("refuses .js and .md artifacts (Markdown uses the docs route)", async () => {
    expect((await raw(art("docs/app.js"))).status).toBe(403);
    expect((await raw(art("docs/spec.md"))).status).toBe(403);
    expect((await meta(art("docs/spec.md"))).status).toBe(403);
  });

  it("refuses URLs, spec links, a missing link, a bad id, and other topics' links", async () => {
    expect((await raw(art("https://example.com/a.html"))).status).toBe(400);
    expect((await raw(art("docs/page.html", undefined, "spec"))).status).toBe(400);
    expect((await raw(9999)).status).toBe(404);
    expect((await get("/api/topics/t/artifacts/abc/raw")).status).toBe(400);
    cli.createTopic({ slug: "o", title: "O" }, owner);
    const l = cli.addLink(
      "o",
      { kind: "artifact", target: join(repo, "docs", "page.html") },
      owner,
    );
    expect((await raw(l.id)).status).toBe(404);
  });

  it("404s for a missing file", async () => {
    expect((await raw(art("docs/gone.html"))).status).toBe(404);
  });

  it("caps the size at 10 MB (2 MB pages still load)", async () => {
    writeFileSync(join(repo, "docs", "mid.html"), "x".repeat(3 * 1024 * 1024));
    expect((await raw(art("docs/mid.html"))).status).toBe(200);
    writeFileSync(join(repo, "docs", "big.html"), "x".repeat(10 * 1024 * 1024 + 1));
    expect((await raw(art("docs/big.html"))).status).toBe(413);
    expect((await meta(art("docs/big.html"))).status).toBe(413);
  });
});

describe("GET /api/topics/:slug/artifacts/:linkId", () => {
  it("returns metadata with the label as title", async () => {
    const id = art("docs/page.html", "Inbox mockup");
    utimesSync(join(repo, "docs", "page.html"), 1_700_000_000, 1_700_000_000);
    const r = await meta(id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      linkId: id,
      kind: "html",
      title: "Inbox mockup",
      relPath: "docs/page.html",
      mtime: 1_700_000_000_000,
      size: 28,
    });
    expect(r.body.path).toMatch(/docs\/page\.html$/);
  });

  it("uses the file name without a label, and reports images", async () => {
    const r = await meta(art("docs/pic.png"));
    expect(r.body).toMatchObject({ kind: "image", title: "pic.png", size: PNG.length });
  });
});
