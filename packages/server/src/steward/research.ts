import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Axiom, StewardSettings } from "@axiom/core";
import {
  classifyConnectors,
  isReadTool,
  normalizeServerName,
  type ProbeResult,
  type SourceAvailability,
} from "./connectors.js";
import { READ_GIT_PATH } from "./read-git.js";

/**
 * What Steward's research stages (gather and the chat) may look at, beyond what Axiom puts in the
 * prompt (follow-up SF2, 2026-11-26). The owner: "It never seems to know anything when I ask,
 * rather than being able to simply go look it up elsewhere and find the answers."
 *
 * - **Repositories:** the folders of the topics' `repository` and `worktree` links, readable with
 *   Read, Grep and Glob (`--add-dir`), and their history through `read-git` (read-only git, the
 *   check in code).
 * - **GitHub:** read-only `gh` subcommands, by prefix (the subcommand is fixed, so a prefix rule
 *   cannot reach a write).
 * - **Connectors:** the read tools of every connected connector (Slack and Google Drive by their
 *   own switches, the rest by `sources.otherConnectors`). Their other tools are denied by name,
 *   since the call loads the user's settings, whose allow rules would otherwise apply.
 *
 * Everything else is denied: the stage runs in `dontAsk` mode, which refuses any tool call no rule
 * allows, and the deny rules below win over any allow rule in the user's settings.
 */

/** `gh` subcommands that only read. Each is allowed as a prefix. */
export const GH_READ = [
  "gh pr view",
  "gh pr list",
  "gh pr checks",
  "gh pr diff",
  "gh pr status",
  "gh run view",
  "gh run list",
  "gh issue view",
  "gh issue list",
  "gh issue status",
  "gh search",
  "gh repo view",
  "gh release list",
  "gh release view",
  "gh workflow list",
  "gh workflow view",
];

/**
 * Denied even if the user's settings allow them. Most are not allowed anyway; these make sure a
 * broad allow rule in the owner's own settings cannot open them for Steward.
 */
export const SHELL_DENIED = [
  "Bash(git push *)",
  "Bash(git commit *)",
  "Bash(git reset *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git rebase *)",
  "Bash(git merge *)",
  "Bash(git branch -d *)",
  "Bash(git branch -D *)",
  "Bash(git tag *)",
  "Bash(git stash *)",
  "Bash(git clean *)",
  "Bash(gh pr merge *)",
  "Bash(gh pr comment *)",
  "Bash(gh pr create *)",
  "Bash(gh pr close *)",
  "Bash(gh pr edit *)",
  "Bash(gh pr review *)",
  "Bash(gh pr ready *)",
  "Bash(gh issue create *)",
  "Bash(gh issue comment *)",
  "Bash(gh issue close *)",
  "Bash(gh issue edit *)",
  "Bash(gh api *)",
  "Bash(gh pr checks * --watch*)",
  "Bash(gh run watch *)",
  "Bash(rm *)",
];

/** The command prefix the model uses for git, as the prompt shows it and the rule allows it. */
export function readGitCommand(path = READ_GIT_PATH): string {
  return `node ${path}`;
}

/** The allow rules for the shell. */
export function shellAllowed(path = READ_GIT_PATH): string[] {
  return [
    `Bash(${readGitCommand(path)} *)`,
    ...GH_READ.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
  ];
}

export interface ResearchConnector {
  /** The name as Claude Code shows it, for example `claude.ai Atlassian`. */
  name: string;
  /** The read tools the stage may call (full names). */
  tools: string[];
}

export interface ResearchAccess {
  /** Folders the stage may read: the topics' repositories and worktrees that exist. */
  dirs: string[];
  /** Connectors whose read tools the stage may call, Slack and Google Drive included. */
  connectors: ResearchConnector[];
  /** Read tools allowed, by full name. */
  mcpTools: string[];
  /** The other tools of the connected connectors, denied by name. */
  mcpDenied: string[];
  /** Slack and Google Drive as before (the checklist and the view use them). */
  sources: { slack: SourceAvailability; googleDrive: SourceAvailability };
  /** Whether `gh` may be used (the GitHub source is on). */
  gh: boolean;
}

const expand = (p: string, home: string) =>
  p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folders of the `repository` and `worktree` links that exist on this machine, for the topics
 * given (all topics that are not done when none are), most recently worked topic first.
 */
export function linkedFolders(
  ax: Axiom,
  o: { topics?: Iterable<string>; home?: string; max?: number } = {},
): { dir: string; topics: string[] }[] {
  const home = o.home ?? homedir();
  const wanted = o.topics ? new Set(o.topics) : null;
  const order = new Map(
    ax
      .listTopics()
      .filter((t) => t.stewardEnabled && (wanted ? wanted.has(t.slug) : t.status !== "done"))
      .sort((a, b) => b.lastWorkedAt.localeCompare(a.lastWorkedAt))
      .map((t, i) => [t.slug, i]),
  );
  const out = new Map<string, { dir: string; topics: string[]; rank: number }>();
  for (const kind of ["repository", "worktree"] as const) {
    for (const l of ax.listLinksOfKind(kind)) {
      const rank = order.get(l.topicSlug);
      if (rank === undefined) continue;
      const dir = expand(l.target.trim(), home).replace(/\/+$/, "");
      if (!isAbsolute(dir) || !isDir(dir)) continue;
      const hit = out.get(dir);
      if (hit) {
        if (!hit.topics.includes(l.topicSlug)) hit.topics.push(l.topicSlug);
        hit.rank = Math.min(hit.rank, rank);
      } else out.set(dir, { dir, topics: [l.topicSlug], rank });
    }
  }
  return [...out.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, o.max ?? 12)
    .map(({ dir, topics }) => ({ dir, topics }));
}

const SOURCE_NAME = { slack: /slack/i, googleDrive: /google[\s_-]*drive|gdrive/i };

/** What the stage may reach, from the connector probe and the settings. */
export function researchAccess(
  probe: ProbeResult | null,
  settings: StewardSettings,
  dirs: string[],
): ResearchAccess {
  const off = (reason: string): SourceAvailability => ({
    available: false,
    reason,
    tools: [],
    servers: [],
  });
  const classified = probe
    ? classifyConnectors(probe)
    : { slack: off("not probed"), googleDrive: off("not probed") };
  const sources = {
    slack: settings.sources.slack ? classified.slack : off("off in settings"),
    googleDrive: settings.sources.googleDrive ? classified.googleDrive : off("off in settings"),
  };
  const connectors: ResearchConnector[] = [];
  const mcpTools: string[] = [];
  const mcpDenied: string[] = [];
  for (const s of probe?.ok ? probe.servers : []) {
    if (s.status !== "connected") continue;
    const kind = SOURCE_NAME.slack.test(s.name)
      ? "slack"
      : SOURCE_NAME.googleDrive.test(s.name)
        ? "googleDrive"
        : "other";
    const allowed =
      kind === "other" ? settings.sources.otherConnectors : sources[kind].available === true;
    const read = allowed ? s.tools.filter(isReadTool) : [];
    mcpDenied.push(...s.tools.filter((t) => !read.includes(t)));
    if (read.length === 0) continue;
    connectors.push({ name: s.name, tools: read });
    mcpTools.push(...read);
  }
  return { dirs, connectors, mcpTools, mcpDenied, sources, gh: settings.sources.github };
}

/** The part of a research stage's prompt that says what it can look at and how. */
export function researchPrompt(
  a: ResearchAccess,
  folders: { dir: string; topics: string[] }[],
  gitCommand = readGitCommand(),
): string {
  const lines: string[] = [];
  if (folders.length) {
    lines.push(
      `- **Repositories** (Read, Grep and Glob work in these folders; git through \`${gitCommand} <folder> <subcommand> ...\`, read-only subcommands such as log, show, diff, status, branch --list, blame, grep):`,
    );
    for (const f of folders) lines.push(`  - ${f.dir} (${f.topics.join(", ")})`);
  } else lines.push("- **Repositories:** none of the topics links a folder on this machine.");
  lines.push(
    a.gh
      ? `- **GitHub** through \`gh\`, read-only: ${GH_READ.map((c) => c.replace(/^gh /, "")).join(", ")}. Pass the repository with \`-R owner/name\` or a full URL.`
      : "- **GitHub:** off in Steward's settings.",
  );
  if (a.connectors.length) {
    lines.push("- **Connectors** (read tools only):");
    for (const c of a.connectors) {
      const short = c.tools.map((t) => t.split("__").slice(2).join("__"));
      lines.push(
        `  - ${c.name}: ${short.slice(0, 12).join(", ")}${short.length > 12 ? ", …" : ""}`,
      );
    }
  } else lines.push("- **Connectors:** none is connected to Claude Code on this machine.");
  lines.push(
    "Anything else (writing, posting, sending, other commands) is refused by the permission rules; do not try to get around a refusal. Do not use `cd`: pass the folder to the command instead.",
  );
  return lines.join("\n");
}

/** Up to `max` commits on any branch of a folder since `since`, one line each; [] if not git. */
export function recentCommits(
  dir: string,
  since: string,
  o: { max?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [
        "-C",
        dir,
        "log",
        "--all",
        "--no-merges",
        `--since=${since}`,
        `-n${o.max ?? 15}`,
        "--date=format:%Y-%m-%d %H:%M",
        "--format=%h %ad %an%d: %s",
      ],
      { env: { ...(o.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        );
      },
    );
  });
}

/** The full tool names of a server, as Claude Code writes them (tests). */
export const toolName = (server: string, tool: string) =>
  `mcp__${normalizeServerName(server)}__${tool}`;
