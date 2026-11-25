import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Actor, type Axiom, AxiomError } from "@axiom/core";
import type { Hono } from "hono";
import { z } from "zod";
import type { ChangeBus } from "./events.js";

const owner: Actor = { kind: "owner" };
const WORKSPACE_CAP = 100;

export interface Workspace {
  path: string;
  label: string;
  source: "axiom" | "projects";
}

const body = z.strictObject({
  slug: z.string().optional(),
  title: z.string(),
  goal: z.string().optional(),
  epic: z.string().min(1).optional(),
  ticket: z.string().min(1).optional(),
  repository: z.string().optional(),
});

/** Lowercase kebab-case from a title; "topic" when nothing usable is left. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "topic";
}

/** `~` and `~/x` become absolute; anything else must already be absolute. */
export function expandFolder(raw: string, home = homedir()): string {
  const p = raw.trim();
  let out: string;
  if (p === "~") out = home;
  else if (p.startsWith("~/")) out = join(home, p.slice(2));
  else if (isAbsolute(p)) out = p;
  else throw new AxiomError("validation", "repository must be an absolute path (or start with ~)");
  return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

const tilde = (p: string, home: string) =>
  p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;

function isGitRepo(path: string): boolean {
  try {
    statSync(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function listWorkspaces(ax: Axiom, home = homedir()): Workspace[] {
  const out: Workspace[] = [];
  const seen = new Set<string>();
  const add = (path: string, source: Workspace["source"]) => {
    if (seen.has(path) || out.length >= WORKSPACE_CAP) return;
    seen.add(path);
    out.push({ path, label: tilde(path, home), source });
  };
  const rows = ax.db
    .prepare(
      `SELECT target FROM link WHERE kind IN ('repository', 'worktree')
       GROUP BY target ORDER BY max(created_at) DESC, max(id) DESC`,
    )
    .all() as { target: string }[];
  for (const r of rows) {
    try {
      add(expandFolder(r.target, home), "axiom");
    } catch {
      // A relative target is not a folder suggestion.
    }
  }
  try {
    const root = join(home, "projects");
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name);
      try {
        if (statSync(path).isDirectory() && isGitRepo(path)) add(path, "projects");
      } catch {
        // Unreadable entry: skip.
      }
    }
  } catch {
    // No ~/projects.
  }
  return out;
}

export function registerNewTopicRoutes(app: Hono, o: { ax: Axiom; bus: ChangeBus }): void {
  const { ax, bus } = o;

  app.get("/api/workspaces", (c) => c.json(listWorkspaces(ax)));

  app.post("/api/topics", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AxiomError("validation", "request body must be valid JSON");
    }
    const r = body.safeParse(raw);
    if (!r.success) {
      throw new AxiomError(
        "validation",
        r.error.issues
          .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
          .join("; "),
      );
    }
    const input = r.data;
    const title = input.title.trim();
    if (!title) throw new AxiomError("validation", "title is required");
    const goal = input.goal?.trim() || undefined;
    const repository = input.repository?.trim() ? expandFolder(input.repository) : undefined;
    const epic = input.epic ? ax.listEpics().find((e) => e.slug === input.epic) : undefined;
    if (input.epic && !epic) throw new AxiomError("not-found", `epic not found: ${input.epic}`);
    const ticket = input.ticket ? ax.listTickets().find((t) => t.slug === input.ticket) : undefined;
    if (input.ticket && !ticket) {
      throw new AxiomError("not-found", `ticket not found: ${input.ticket}`);
    }

    let slug = input.slug?.trim();
    if (!slug) {
      const base = slugify(title);
      const taken = new Set(ax.listTopics({}).map((t) => t.slug));
      slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    }
    ax.createTopic({ slug, title, goal }, owner);
    if (epic) ax.addTopicToEpic(slug, epic.slug, owner);
    if (ticket) ax.addTopicToTicket(slug, ticket.slug, owner);
    if (repository) ax.addLink(slug, { kind: "repository", target: repository }, owner);
    bus.emit();
    return c.json(ax.getTopic(slug), 201);
  });
}
