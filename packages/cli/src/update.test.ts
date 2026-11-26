import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runUpdate, updateArgs } from "./update.js";

let dir: string;
let origin: string;
let repo: string;
let app: string;
let other: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function commit(cwd: string, file: string) {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
}

/** A commit pushed to origin from another clone: what `axiom update` should pull. */
function upstreamCommit(file: string) {
  git(other, "pull", "--quiet", "--ff-only");
  commit(other, file);
  git(other, "push", "--quiet", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

function run(args: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const installs: { script: string; args: string[]; cwd: string }[] = [];
  const code = runUpdate(
    args,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    {
      from: join(app, "packages", "cli"),
      runInstall: (script, a, cwd) => {
        installs.push({ script, args: a, cwd });
        return 0;
      },
    },
  );
  return { code, out: out.join("\n"), err: err.join("\n"), installs };
}

beforeAll(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  });
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "axiom-update-")));
  origin = join(dir, "origin.git");
  repo = join(dir, "checkout");
  app = join(dir, "app");
  other = join(dir, "other");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, repo], { stdio: "ignore" });
  git(repo, "checkout", "--quiet", "-b", "main");
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts", "install.sh"), "#!/bin/sh\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "push", "--quiet", "-u", "origin", "main");
  git(repo, "worktree", "add", "--quiet", "--detach", app, "main");
  mkdirSync(join(app, "packages", "cli"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin, other], { stdio: "ignore" });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("updateArgs", () => {
  it("picks out `axiom update` and drops --db / --json", () => {
    expect(updateArgs(["update", "--yes"])).toEqual(["--yes"]);
    expect(updateArgs(["--db", "x.db", "--json", "update"])).toEqual([]);
    expect(updateArgs(["topic", "list"])).toBeNull();
  });
});

describe("axiom update", () => {
  it("fast-forwards the checked-out main and runs install.sh on it with the release copy", () => {
    const head = upstreamCommit("a.txt");
    const r = run(["--yes"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(git(repo, "rev-parse", "main")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe(""); // the files moved with it
    expect(r.out).toMatch(/Fast-forwarded main .* \(1 commit\)/);
    expect(r.installs).toEqual([
      {
        script: join(repo, "scripts", "install.sh"),
        args: ["--ref", "main", "--app-dir", app, "--yes"],
        cwd: repo,
      },
    ]);
  });

  it("moves main without touching the branch the checkout is on", () => {
    git(repo, "checkout", "--quiet", "-b", "work");
    const head = upstreamCommit("b.txt");
    const r = run();
    expect(r.code).toBe(0);
    expect(git(repo, "rev-parse", "main")).toBe(head);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("work");
    expect(git(repo, "rev-parse", "work")).not.toBe(head);
    expect(r.installs).toHaveLength(1);
  });

  it("installs as it is when main is already up to date", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/main is up to date with origin\/main/);
    expect(r.installs).toHaveLength(1);
  });

  it("refuses when main and its upstream have diverged", () => {
    upstreamCommit("theirs.txt");
    commit(repo, "mine.txt");
    const before = git(repo, "rev-parse", "main");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/have diverged/);
    expect(git(repo, "rev-parse", "main")).toBe(before);
    expect(r.installs).toHaveLength(0);
  });

  it("--dry-run changes nothing and runs nothing", () => {
    upstreamCommit("c.txt");
    const before = git(repo, "rev-parse", "main");
    const r = run(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Would fast-forward main/);
    expect(r.out).toMatch(/Would run: .*install\.sh --ref main --app-dir/);
    expect(git(repo, "rev-parse", "main")).toBe(before);
    expect(r.installs).toHaveLength(0);
  });

  it("says how to set an upstream when main has none", () => {
    git(repo, "branch", "--unset-upstream", "main");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no upstream.*branch -u origin\/main main/);
  });
});
