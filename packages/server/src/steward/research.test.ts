import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Axiom, DEFAULT_STEWARD_SETTINGS, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READ_GIT_PATH, refuseGit } from "./read-git.js";
import {
  linkedFolders,
  recentCommits,
  researchAccess,
  researchPrompt,
  shellAllowed,
  toolName,
} from "./research.js";

const owner = { kind: "owner" } as const;
let dir: string;
let ax: Axiom;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-research-"));
  ax = openDatabase(join(dir, "axiom.db"));
});
afterEach(() => {
  ax.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("read-git", () => {
  it("allows read-only subcommands and refuses writes, programs and output files", () => {
    for (const ok of [
      ["/r", "log", "--oneline", "-5"],
      ["/r", "show", "HEAD"],
      ["/r", "diff", "main...feat"],
      ["/r", "status"],
      ["/r", "branch", "-a"],
      ["/r", "branch", "--list", "feat/*"],
      ["/r", "grep", "-e", "TODO"],
      ["/r", "tag"],
      ["/r", "tag", "-l", "v*"],
      ["/r", "worktree", "list"],
      ["/r", "remote", "-v"],
    ]) {
      expect(refuseGit(ok)).toBeNull();
    }
    for (const bad of [
      ["/r", "push", "origin"],
      ["/r", "commit", "-m", "x"],
      ["/r", "checkout", "main"],
      ["/r", "fetch"],
      ["/r", "branch", "-D", "x"],
      ["/r", "branch", "newbranch"],
      ["/r", "tag", "v1"],
      ["/r", "worktree", "add", "/x"],
      ["/r", "reflog", "expire"],
      ["/r", "remote", "add", "x", "y"],
      ["/r", "diff", "--output=/tmp/x"],
      ["/r", "grep", "-Ovim", "x"],
      ["/r", "log", "--ext-diff"],
      ["/r"],
    ]) {
      expect(refuseGit(bad)).not.toBeNull();
    }
  });

  it("runs git read-only in the given folder and exits 2 on a refusal", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q");
    git(
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=A",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    );
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", READ_GIT_PATH, repo, "log", "--format=%s"],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("first");
    let code = 0;
    try {
      execFileSync(process.execPath, ["--import", "tsx", READ_GIT_PATH, repo, "push"], {
        stdio: "pipe",
      });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  });
});

describe("research access", () => {
  it("lists the folders the topics link that exist, most recent topic first, Steward-off ones left out", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    ax.createTopic({ slug: "one", title: "One" }, owner);
    ax.createTopic({ slug: "two", title: "Two" }, owner);
    ax.createTopic({ slug: "off", title: "Off" }, owner);
    ax.addLink("one", { kind: "repository", target: a }, owner);
    ax.addLink("two", { kind: "repository", target: a }, owner);
    ax.addLink("two", { kind: "worktree", target: b }, owner);
    ax.addLink("two", { kind: "repository", target: join(dir, "missing") }, owner);
    ax.addLink("off", { kind: "repository", target: join(dir, "c") }, owner);
    mkdirSync(join(dir, "c"));
    ax.setTopicStewardEnabled("off", false, owner);
    const all = linkedFolders(ax);
    expect(all.map((f) => f.dir).sort()).toEqual([a, b].sort());
    expect(all.find((f) => f.dir === a)?.topics.sort()).toEqual(["one", "two"]);
    expect(linkedFolders(ax, { topics: ["one"] }).map((f) => f.dir)).toEqual([a]);
  });

  it("allows the read tools of every connected connector and denies the rest by name", () => {
    const tools = (server: string, ...names: string[]) => names.map((n) => toolName(server, n));
    const probe = {
      ok: true,
      at: 1,
      servers: [
        {
          name: "claude.ai Slack",
          status: "connected",
          tools: tools("claude.ai Slack", "slack_search_public", "slack_send_message"),
        },
        {
          name: "claude.ai Atlassian",
          status: "connected",
          tools: tools("claude.ai Atlassian", "searchJiraIssuesUsingJql", "createJiraIssue"),
        },
        { name: "claude.ai Gmail", status: "needs-auth", tools: [] },
      ],
    };
    const a = researchAccess(probe, DEFAULT_STEWARD_SETTINGS, ["/r"]);
    expect(a.connectors.map((c) => c.name)).toEqual(["claude.ai Slack", "claude.ai Atlassian"]);
    expect(a.mcpTools).toEqual([
      "mcp__claude_ai_Slack__slack_search_public",
      "mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql",
    ]);
    expect(a.mcpDenied).toEqual([
      "mcp__claude_ai_Slack__slack_send_message",
      "mcp__claude_ai_Atlassian__createJiraIssue",
    ]);
    expect(a.sources.slack.available).toBe(true);

    const noOthers = researchAccess(
      probe,
      {
        ...DEFAULT_STEWARD_SETTINGS,
        sources: { ...DEFAULT_STEWARD_SETTINGS.sources, otherConnectors: false, slack: false },
      },
      [],
    );
    expect(noOthers.connectors).toEqual([]);
    expect(noOthers.mcpDenied).toHaveLength(4);
    expect(noOthers.sources.slack.reason).toBe("off in settings");

    const text = researchPrompt(a, [{ dir: "/r", topics: ["one"] }], "node /x/read-git.js");
    expect(text).toContain("/r (one)");
    expect(text).toContain("`node /x/read-git.js <folder> <subcommand> ...`");
    expect(text).toContain("claude.ai Atlassian: searchJiraIssuesUsingJql");
    expect(text).toContain("pr view");
    expect(shellAllowed("/x/read-git.js")[0]).toBe("Bash(node /x/read-git.js *)");
  });

  it("reads a folder's recent commits, and nothing from a folder that is not a repository", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q");
    git(
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=Ann",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "hello",
    );
    const lines = await recentCommits(repo, "2000-01-01T00:00:00Z");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^[0-9a-f]+ \d{4}-\d\d-\d\d \d\d:\d\d Ann.*: hello$/);
    expect(await recentCommits(dir, "2000-01-01T00:00:00Z")).toEqual([]);
  });
});
