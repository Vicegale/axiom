import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Context } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function fileIn(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = normalize(join(root, decoded));
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** Serves the built web app, falling back to index.html for client-side routes. */
export function serveWeb(c: Context, webDist: string): Response {
  const index = join(webDist, "index.html");
  if (!existsSync(index)) {
    const path = new URL(c.req.url).pathname;
    if (path === "/") {
      return c.text("Axiom web app not built. Run `npm run build` in the repository.\n");
    }
    return c.text("not found\n", 404);
  }
  const path = new URL(c.req.url).pathname;
  const file = fileIn(webDist, path);
  const target = file ?? index;
  const body = readFileSync(target);
  const headers: Record<string, string> = {
    "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
    "cache-control": target === index ? "no-cache" : "public, max-age=31536000, immutable",
  };
  return new Response(c.req.method === "HEAD" ? null : body, { headers });
}
