import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Axiom, Link } from "@axiom/core";

/** Largest file the viewer will read, for Markdown and images alike. */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

const DOC_EXTS = new Set([".md", ".markdown"]);
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** A refusal with its HTTP status; the routes turn it into the API's error shape. */
export class DocsError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DocResult {
  linkId: number;
  path: string;
  relPath: string;
  root: string;
  /** The linked document's directory: what `?path=` is relative to. */
  baseDir: string;
  title: string;
  markdown: string;
  mtime: number;
}

export interface FileResult {
  bytes: Buffer;
  type: string;
}

/** A link target as a filesystem path: `~` expands, absolute stays, relative joins `base`. */
function expand(target: string, base: string | null): string {
  if (target === "~" || target.startsWith("~/")) return join(homedir(), target.slice(1));
  if (isAbsolute(target)) return resolve(target);
  if (base === null) {
    throw new DocsError(
      400,
      "validation",
      "a relative path needs a repository or worktree link on the topic",
    );
  }
  return resolve(base, target);
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface Scope {
  links: readonly Link[];
  /** Where relative targets resolve: the first repository link, else the first worktree link. */
  base: string | null;
  /** Real paths of the repository and worktree directories. */
  roots: string[];
  /** Real paths of the exact files its spec and artifact links name. */
  files: string[];
}

function scopeOf(ax: Axiom, slug: string): Scope {
  const links = ax.getTopic(slug).links;
  const first = (kind: string) => links.find((l) => l.kind === kind);
  const baseLink = first("repository") ?? first("worktree");
  const base = baseLink ? expand(baseLink.target, null) : null;
  const roots: string[] = [];
  for (const l of links) {
    if (l.kind !== "repository" && l.kind !== "worktree") continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(l.target)) continue; // a URL, not a directory
    try {
      const r = real(expand(l.target, null));
      if (r && statSync(r).isDirectory()) roots.push(r);
    } catch {}
  }
  const files: string[] = [];
  for (const l of links) {
    if (l.kind !== "spec" && l.kind !== "artifact") continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(l.target)) continue;
    try {
      const abs = expand(l.target, base);
      files.push(real(abs) ?? abs);
    } catch {}
  }
  return { links, base, roots, files };
}

function allowed(scope: Scope, realPath: string): string | null {
  const root = scope.roots.find((r) => inside(r, realPath));
  if (root) return root;
  return scope.files.includes(realPath) ? dirname(realPath) : null;
}

/** Resolves `abs` to a real path the topic may read, or throws 403 / 404. */
function access(scope: Scope, abs: string, exts: ReadonlySet<string>) {
  if (!exts.has(extname(abs).toLowerCase())) {
    throw new DocsError(403, "permission", "that file type cannot be shown");
  }
  const realPath = real(abs);
  if (realPath === null) {
    // Missing: 404 when it would have been allowed, 403 when it is somewhere it never could be.
    if (!scope.roots.some((r) => inside(r, abs)) && !scope.files.includes(abs)) {
      throw new DocsError(403, "permission", "that path is outside the topic's directories");
    }
    throw new DocsError(404, "not-found", "no such file");
  }
  const root = allowed(scope, realPath);
  if (root === null) {
    throw new DocsError(403, "permission", "that path is outside the topic's directories");
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(realPath);
  } catch {
    throw new DocsError(404, "not-found", "no such file");
  }
  if (!st.isFile()) throw new DocsError(404, "not-found", "not a file");
  if (st.size > MAX_DOC_BYTES) {
    throw new DocsError(413, "too-large", "file is larger than 2 MB");
  }
  return { realPath, root, mtime: st.mtimeMs };
}

/** The title of a Markdown file: its first level-one heading outside code fences. */
export function titleOf(markdown: string, fallback: string): string {
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1] as string;
      if (fence === null) fence = mark[0] as string;
      else if (mark[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h) return (h[1] as string).trim();
  }
  return fallback;
}

export async function readDoc(
  ax: Axiom,
  slug: string,
  linkId: number,
  sub: string | undefined,
): Promise<DocResult> {
  const scope = scopeOf(ax, slug);
  const link = scope.links.find((l) => l.id === linkId);
  if (!link) throw new DocsError(404, "not-found", `topic ${slug} has no link ${linkId}`);
  if (link.kind !== "spec" && link.kind !== "artifact") {
    throw new DocsError(400, "validation", "only spec and artifact links open in the viewer");
  }
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(link.target) ||
    !DOC_EXTS.has(extname(link.target).toLowerCase())
  ) {
    throw new DocsError(400, "validation", "the link is not a local Markdown file");
  }
  const linked = expand(link.target, scope.base);
  const baseDir = dirname(real(linked) ?? linked);
  const abs = sub === undefined || sub === "" ? linked : resolve(baseDir, sub);
  const { realPath, root, mtime } = access(scope, abs, DOC_EXTS);
  const markdown = (await readFile(realPath, "utf8")).replace(/^﻿/, "");
  return {
    linkId,
    path: realPath,
    relPath: relative(root, realPath) || basename(realPath),
    root,
    baseDir,
    title: titleOf(markdown, basename(realPath)),
    markdown,
    mtime,
  };
}

export async function readImage(ax: Axiom, slug: string, path: string): Promise<FileResult> {
  const scope = scopeOf(ax, slug);
  const abs = expand(path, scope.base);
  const { realPath } = access(scope, abs, new Set(Object.keys(IMAGE_TYPES)));
  return {
    bytes: await readFile(realPath),
    type: IMAGE_TYPES[extname(realPath).toLowerCase()] as string,
  };
}
