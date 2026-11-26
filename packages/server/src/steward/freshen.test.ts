import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discardFix } from "./fixes.js";
import {
  adoptRebase,
  isRebaseCopy,
  memoryOptOut,
  NO_REBASE,
  rebaseDiff,
  runFreshen,
  undoRebase,
} from "./freshen.js";
import { buildStewardView } from "./view.js";

const owner = { kind: "owner" } as const;
const steward = { kind: "steward" } as const;

let dir: string;
let ax: Axiom;
let savedXdg: string | undefined;

const sh = (cwd: string, cmd: string) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const refs = (cwd: string) => sh(cwd, "git for-each-ref");

/**
 * A throwaway world: a bare origin, the owner's clone on `feature` (one commit touching b.txt),
 * a second clone that moves main (`conflict`: the same line of b.txt; else a.txt) and an open PR
 * snapshot for `feature`.
 */
function setup(
  o: { conflict?: boolean; status?: "review" | "wip"; signal?: boolean; base?: string } = {},
) {
  const repo = join(dir, "widgets");
  const origin = join(dir, "origin.git");
  const other = join(dir, "other");
  sh(dir, `git init -q -b main ${repo}`);
  sh(repo, "git config user.name Owner && git config user.email owner@example.com");
  writeFileSync(join(repo, "a.txt"), "a1\na2\na3\n");
  writeFileSync(join(repo, "b.txt"), "b1\nb2\nb3\n");
  sh(repo, "git add -A && git commit -qm init");
  sh(dir, `git clone -q --bare ${repo} ${origin}`);
  sh(repo, `git remote add origin ${origin}`);
  sh(repo, "git fetch -q origin");
  sh(repo, "git branch -q -u origin/main main");
  sh(repo, `git config url.${origin}.insteadOf https://github.com/acme/widgets.git`);
  sh(repo, "git remote set-url origin https://github.com/acme/widgets.git");
  sh(repo, "git checkout -q -b feature");
  writeFileSync(join(repo, "b.txt"), "b1\nb2 feature\nb3\n");
  sh(repo, "git commit -qam 'feature: b2'");
  writeFileSync(join(repo, "c.txt"), "c\n");
  sh(repo, "git add -A && git commit -qm 'feature: c'");
  sh(repo, "git push -q origin feature");
  sh(dir, `git clone -q ${origin} ${other}`);
  sh(other, "git config user.name Other && git config user.email other@example.com");
  if (o.conflict) writeFileSync(join(other, "b.txt"), "b1\nb2 main\nb3\n");
  else writeFileSync(join(other, "a.txt"), "a1\na2 main\na3\n");
  sh(other, "git commit -qam 'main moves' && git push -q origin main");
  if (o.base) sh(other, `git push -q origin main:refs/heads/${o.base}`);

  ax.createTopic({ slug: "alpha", title: "Alpha", status: o.status ?? "review" }, owner);
  ax.addLink("alpha", { kind: "repository", target: repo }, owner);
  ax.addLink("alpha", { kind: "pr", target: "acme/widgets#7" }, owner);
  ax.saveStewardPr(
    {
      repo: "acme/widgets",
      number: 7,
      state: "OPEN",
      snapshot: {
        repo: "acme/widgets",
        number: 7,
        state: "OPEN",
        headRef: "feature",
        baseRef: o.base ?? "main",
      },
      active: o.signal ? { "conflict coming": "MERGEABLE:b.txt" } : {},
      fired: [],
    },
    steward,
  );
  return { repo, origin, other };
}

const wakeId = () => ax.startStewardWake({ trigger: "owner" }, steward).id;
const freshen = (extra: { topic?: string; now?: Date } = {}) =>
  runFreshen({ ax, wakeId: wakeId(), ...extra });
const tip = (repo: string, ref: string) => sh(repo, `git rev-parse ${ref}`);
const suggestions = () => ax.listStewardItems().filter((i) => i.kind === "suggestion");
const findings = () => ax.listStewardItems().filter((i) => i.kind === "finding");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-freshen-"));
  savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, "data");
  ax = openDatabase(":memory:");
  ax.setStewardSettings({ enabled: true }, owner);
});
afterEach(() => {
  ax.close();
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("in place", () => {
  it("rebases when behind and a conflict is coming, saving a backup and never pushing", async () => {
    const { repo, origin } = setup({ conflict: false, status: "wip", signal: true });
    const before = refs(origin);
    const old = tip(repo, "feature");
    const r = await freshen({ now: new Date("2026-11-25T14:00:05Z") });
    expect(r.items).toHaveLength(1);
    const main = tip(repo, "origin/main");
    expect(sh(repo, "git merge-base --is-ancestor origin/main feature; echo $?")).toBe("0");
    const now = tip(repo, "feature");
    expect(now).not.toBe(old);
    expect(sh(repo, "git rev-list --count origin/main..feature")).toBe("2");
    // the backup ref holds the old tip
    const backup = "refs/axiom/backup/feature/20261125-140005";
    expect(tip(repo, backup)).toBe(old);
    // the finding, its action and a Steward-authored history entry
    const f = findings()[0];
    expect(f?.title).toBe("feature was behind main (acme/widgets#7)");
    expect(f?.level).toBe("info");
    const a = ax.listStewardActions({ itemId: f?.id })[0];
    expect(a?.kind).toBe("rebase in place");
    expect(a?.data).toMatchObject({
      repo,
      branch: "feature",
      base: "main",
      oldTip: old,
      newTip: now,
      baseTip: main,
      backupRef: backup,
    });
    const entry = ax.listEntries("alpha").find((e) => e.kind === "finding");
    expect(entry?.author).toBe("steward");
    expect(entry?.body).toContain("Rebased feature onto main locally (clean)");
    expect(entry?.body).toContain(backup);
    // never pushed: the bare origin is exactly as it was, and its feature is still the old tip
    expect(refs(origin)).toBe(before);
    expect(tip(origin, "feature")).toBe(old);
    // the same tips are not done twice
    expect((await freshen()).items).toHaveLength(0);
  });

  it("rebases when behind and the topic is in review, with no conflict signal", async () => {
    const { repo } = setup({ status: "review", signal: false });
    const r = await freshen();
    expect(r.items).toHaveLength(1);
    expect(sh(repo, "git merge-base --is-ancestor origin/main feature; echo $?")).toBe("0");
  });

  it("does nothing when neither a conflict is coming nor the topic is in review", async () => {
    const { repo, origin } = setup({ status: "wip", signal: false });
    const old = tip(repo, "feature");
    const before = refs(origin);
    expect((await freshen()).items).toHaveLength(0);
    expect(tip(repo, "feature")).toBe(old);
    expect(refs(origin)).toBe(before);
  });

  it("does nothing when the branch is not behind main", async () => {
    const { repo } = setup({ signal: true });
    sh(repo, "git fetch -q origin && git rebase -q origin/main");
    const t = tip(repo, "feature");
    expect((await freshen()).items).toHaveLength(0);
    expect(tip(repo, "feature")).toBe(t);
    expect(ax.listStewardItems()).toHaveLength(0);
    expect(sh(repo, "git for-each-ref refs/axiom")).toBe("");
  });

  it("skips topics Steward is off for and closed PRs", async () => {
    const { repo } = setup({ signal: true });
    const old = tip(repo, "feature");
    ax.setTopicStewardEnabled("alpha", false, owner);
    expect((await freshen()).items).toHaveLength(0);
    ax.setTopicStewardEnabled("alpha", true, owner);
    ax.saveStewardPr(
      {
        repo: "acme/widgets",
        number: 7,
        state: "MERGED",
        snapshot: { headRef: "feature", baseRef: "main" },
        active: {},
        fired: [],
      },
      steward,
    );
    expect((await freshen()).items).toHaveLength(0);
    expect(tip(repo, "feature")).toBe(old);
  });

  it("works on a branch that is not checked out anywhere, in a temporary worktree", async () => {
    const { repo, origin } = setup({ signal: true });
    sh(repo, "git checkout -q main");
    const old = tip(repo, "feature");
    const before = refs(origin);
    const r = await freshen();
    expect(r.items).toHaveLength(1);
    expect(tip(repo, "feature")).not.toBe(old);
    expect(sh(repo, "git rev-parse --abbrev-ref HEAD")).toBe("main");
    expect(sh(repo, "git worktree list --porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(refs(origin)).toBe(before);
  });

  it("rebases where the branch is checked out, in a linked worktree too", async () => {
    const { repo } = setup({ signal: true });
    sh(repo, "git checkout -q main");
    const wt = join(dir, "wt");
    sh(repo, `git worktree add -q ${wt} feature`);
    const r = await freshen();
    expect(r.items).toHaveLength(1);
    expect(sh(wt, "git rev-list --count origin/main..HEAD")).toBe("2");
    expect(sh(wt, "git status --porcelain")).toBe("");
  });

  it("does only one rebase per repository per wake", async () => {
    const { repo } = setup({ signal: true });
    // a second PR and branch in the same repository
    sh(repo, "git checkout -q -b second main");
    writeFileSync(join(repo, "d.txt"), "d\n");
    sh(repo, "git add -A && git commit -qm second && git push -q origin second");
    ax.addLink("alpha", { kind: "pr", target: "acme/widgets#8" }, owner);
    ax.saveStewardPr(
      {
        repo: "acme/widgets",
        number: 8,
        state: "OPEN",
        snapshot: { headRef: "second", baseRef: "main" },
        active: { "conflict coming": "x" },
        fired: [],
      },
      steward,
    );
    const r = await freshen();
    expect(r.items).toHaveLength(1);
    expect((await freshen()).items).toHaveLength(1); // the next wake does the other one
  });
});

describe("copies", () => {
  const copyOf = () =>
    suggestions().find((i) => ax.getStewardSuggestion(i.id).kind === "rebase copy");

  it("rebases a copy when the worktree has uncommitted changes (tracked)", async () => {
    const { repo, origin } = setup({ signal: true });
    writeFileSync(join(repo, "b.txt"), "b1\nlocal edit\nb3\n");
    const old = tip(repo, "feature");
    const before = refs(origin);
    const r = await freshen();
    expect(r.items).toHaveLength(1);
    expect(tip(repo, "feature")).toBe(old); // untouched
    expect(sh(repo, "git status --porcelain")).toBe("M b.txt");
    const item = copyOf();
    expect(item?.title).toBe("feature rebased onto main, as a copy");
    const s = ax.getStewardSuggestion(item?.id as number);
    expect(s.branch).toBe("axiom/rebase/feature");
    expect(s.diffstat).toBe("not in place: your checkout has uncommitted changes · 2 commits");
    expect(s.worktree?.startsWith(join(dir, "data", "axiom", "worktrees"))).toBe(true);
    expect(sh(repo, "git merge-base --is-ancestor origin/main axiom/rebase/feature; echo $?")).toBe(
      "0",
    );
    expect(ax.listStewardActions()).toHaveLength(0);
    expect(refs(origin)).toBe(before);
    expect(buildStewardView(ax, null).ready.map((i) => i.fix?.kind)).toEqual(["rebase copy"]);
  });

  it("treats an untracked file as uncommitted too", async () => {
    const { repo } = setup({ signal: true });
    writeFileSync(join(repo, "scratch.txt"), "x");
    await freshen();
    expect(copyOf()).toBeTruthy();
    expect(ax.listStewardActions()).toHaveLength(0);
  });

  it("rebases a copy when someone else pushed (origin is ahead)", async () => {
    const { repo, other } = setup({ signal: true });
    sh(other, "git fetch -q origin && git checkout -q -b feature origin/feature");
    writeFileSync(join(other, "e.txt"), "e\n");
    sh(other, "git add -A && git commit -qm teammate && git push -q origin feature");
    const old = tip(repo, "feature");
    await freshen();
    expect(tip(repo, "feature")).toBe(old);
    const s = ax.getStewardSuggestion(copyOf()?.id as number);
    expect(s.diffstat).toContain("someone else pushed to the branch");
  });

  it("rebases a copy when the newest pushed commit is by someone else, even if pulled", async () => {
    const { repo, other } = setup({ signal: true });
    sh(other, "git fetch -q origin && git checkout -q -b feature origin/feature");
    writeFileSync(join(other, "e.txt"), "e\n");
    sh(other, "git add -A && git commit -qm teammate && git push -q origin feature");
    sh(repo, "git pull -q --ff-only origin feature");
    const old = tip(repo, "feature");
    await freshen();
    expect(tip(repo, "feature")).toBe(old);
    expect(ax.getStewardSuggestion(copyOf()?.id as number).diffstat).toContain(
      "the newest commit on origin/feature is not yours",
    );
  });

  it("rebases a copy when the base is not main", async () => {
    const { repo } = setup({ signal: true, base: "release" });
    const old = tip(repo, "feature");
    await freshen();
    expect(tip(repo, "feature")).toBe(old);
    expect(ax.listStewardActions()).toHaveLength(0);
    const s = ax.getStewardSuggestion(copyOf()?.id as number);
    expect(s.diffstat).toContain("the base is release, not main");
  });

  it("reports conflicts from the copy attempt and offers nothing", async () => {
    const { repo, origin } = setup({ conflict: true, signal: true });
    writeFileSync(join(repo, "b.txt"), "dirty\n"); // dirty: in place is out, so a copy is tried
    const old = tip(repo, "feature");
    const before = refs(origin);
    const r = await freshen();
    expect(r.items).toHaveLength(1);
    expect(suggestions()).toHaveLength(0);
    const f = findings()[0];
    expect(f?.title).toBe("conflicts rebasing feature onto main: b.txt");
    expect(f?.level).toBe("attention");
    expect(tip(repo, "feature")).toBe(old);
    expect(sh(repo, "git branch --list 'axiom/*'")).toBe("");
    expect(existsSync(join(dir, "data", "axiom", "worktrees", "widgets", "axiom"))).toBe(false);
    expect(sh(repo, "git worktree list --porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(refs(origin)).toBe(before);
    expect((await freshen()).items).toHaveLength(0); // not reported again for the same tips
  });

  it("reports conflicts instead of rebasing in place, leaving the checkout alone", async () => {
    const { repo } = setup({ conflict: true, signal: true });
    const old = tip(repo, "feature");
    await freshen();
    expect(findings()[0]?.title).toBe("conflicts rebasing feature onto main: b.txt");
    expect(tip(repo, "feature")).toBe(old);
    expect(sh(repo, "git status --porcelain")).toBe("");
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(ax.listStewardActions()).toHaveLength(0);
    expect(sh(repo, "git for-each-ref refs/axiom")).toBe("");
  });

  it("replaces a copy still waiting when the branch is freshened again", async () => {
    const { repo, other } = setup({ signal: true });
    writeFileSync(join(repo, "scratch.txt"), "x");
    await freshen();
    const first = copyOf();
    writeFileSync(join(other, "a.txt"), "a1\na2 main again\na3\n");
    sh(other, "git commit -qam again && git push -q origin main");
    await freshen();
    expect(ax.getStewardItem(first?.id as number).state).toBe("discarded");
    const open = suggestions().filter((i) => i.state === "open");
    expect(open).toHaveLength(1);
    // the old copy's branch was removed first, so its name is free again
    expect(ax.getStewardSuggestion(open[0]?.id as number).branch).toBe("axiom/rebase/feature");
  });
});

describe("memory opt-out", () => {
  it("matches the phrases, case-insensitively", () => {
    for (const t of [
      "Merges main into branches; never rebase its branches.",
      "this repo merges main",
      "Never rebase here",
      "Don't rebase atlas branches",
      "do not rebase",
      "Must not be rebased",
      "no rebase",
      "No-rebase repo",
    ]) {
      expect(NO_REBASE.test(t), t).toBe(true);
    }
    for (const t of ["Health check is /healthz", "rebases are fine", "merged main last week"]) {
      expect(NO_REBASE.test(t), t).toBe(false);
    }
  });

  it("only reports, once, and changes nothing", async () => {
    const { repo, origin } = setup({ signal: true });
    ax.addStewardMemory(
      {
        scope: "attached",
        attachedKind: "repo",
        attachedKey: "acme/widgets",
        text: "Merges main into branches; never rebase.",
      },
      owner,
    );
    const old = tip(repo, "feature");
    const before = refs(origin);
    const r = await freshen();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.title).toBe("feature is behind main (acme/widgets#7)");
    expect(r.items[0]?.level).toBe("info");
    expect(tip(repo, "feature")).toBe(old);
    expect(suggestions()).toHaveLength(0);
    expect(ax.listStewardActions()).toHaveLength(0);
    expect(sh(repo, "git branch --list 'axiom/*'")).toBe("");
    expect(refs(origin)).toBe(before);
    expect((await freshen()).items).toHaveLength(0);
  });

  it("matches a memory item attached by folder or repository name", () => {
    const { repo } = setup({ signal: true });
    ax.addStewardMemory(
      { scope: "attached", attachedKind: "repo", attachedKey: repo, text: "Don't rebase these." },
      owner,
    );
    expect(memoryOptOut(ax, { path: repo, name: "widgets", slug: "acme/widgets" })).toContain(
      "Don't",
    );
    expect(memoryOptOut(ax, { path: "/elsewhere/x", name: "x", slug: "acme/x" })).toBeNull();
  });
});

describe("undo", () => {
  async function rebased() {
    const out = setup({ signal: true });
    const old = tip(out.repo, "feature");
    await freshen({ now: new Date("2026-11-25T14:00:05Z") });
    const action = ax.listStewardActions()[0];
    return { ...out, old, action: action as NonNullable<typeof action> };
  }

  it("puts the branch back and keeps the backup ref", async () => {
    const { repo, old, action } = await rebased();
    const undone = await undoRebase(ax, action.id);
    expect(undone.undoneAt).not.toBeNull();
    expect(tip(repo, "feature")).toBe(old);
    expect(sh(repo, "git status --porcelain")).toBe("");
    expect(tip(repo, "refs/axiom/backup/feature/20261125-140005")).toBe(old);
    expect(ax.getStewardItem(action.itemId).state).toBe("undone");
    expect(
      ax
        .listEntries("alpha")
        .some((e) => e.author === "owner" && /Undid Steward's rebase/.test(e.body ?? "")),
    ).toBe(true);
    // not redone for the same tips
    expect((await freshen()).items).toHaveLength(0);
    await expect(undoRebase(ax, action.id)).rejects.toThrow(/already undone/);
  });

  it("works when the branch is not checked out", async () => {
    const { repo, old, action } = await rebased();
    sh(repo, "git checkout -q main");
    await undoRebase(ax, action.id);
    expect(tip(repo, "feature")).toBe(old);
  });

  it("is refused when the branch has moved on", async () => {
    const { repo, action } = await rebased();
    writeFileSync(join(repo, "f.txt"), "f");
    sh(repo, "git add -A && git commit -qm more");
    const moved = tip(repo, "feature");
    await expect(undoRebase(ax, action.id)).rejects.toThrow(/has moved since Steward rebased it/);
    expect(tip(repo, "feature")).toBe(moved);
    expect(ax.listStewardActions()[0]?.undoneAt).toBeNull();
  });

  it("is refused when the checkout has uncommitted changes", async () => {
    const { repo, action } = await rebased();
    writeFileSync(join(repo, "c.txt"), "edited");
    const t = tip(repo, "feature");
    await expect(undoRebase(ax, action.id)).rejects.toThrow(/uncommitted changes/);
    expect(tip(repo, "feature")).toBe(t);
    expect(sh(repo, "cat c.txt")).toBe("edited");
  });

  it("is refused when the backup ref is gone", async () => {
    const { repo, action } = await rebased();
    sh(repo, "git update-ref -d refs/axiom/backup/feature/20261125-140005");
    await expect(undoRebase(ax, action.id)).rejects.toThrow(/backup ref/);
  });
});

describe("a rebased copy: diff, adopt and discard", () => {
  async function copy() {
    const out = setup({ signal: true });
    writeFileSync(join(out.repo, "scratch.txt"), "x"); // untracked: forces a copy
    await freshen();
    const item = suggestions()[0] as NonNullable<ReturnType<typeof suggestions>[number]>;
    rmSync(join(out.repo, "scratch.txt"));
    return { ...out, item };
  }

  it("shows the commits replayed and what changed", async () => {
    const { item } = await copy();
    expect(isRebaseCopy(ax, item.id)).toBe(true);
    const d = await rebaseDiff(ax, item.id);
    expect(d.branch).toBe("axiom/rebase/feature");
    expect(d.diff).toContain("2 commits replayed onto main @");
    expect(d.diff).toContain("feature: b2");
    expect(d.diff).toContain("feature: c");
  });

  it("adopt moves the branch to the copy, saves the old tip, never pushes", async () => {
    const { repo, origin, item } = await copy();
    const before = refs(origin);
    const old = tip(repo, "feature");
    const copyTip = tip(repo, "axiom/rebase/feature");
    const r = await adoptRebase(ax, item.id, new Date("2026-11-25T15:00:00Z"));
    expect(tip(repo, "feature")).toBe(copyTip);
    expect(sh(repo, "git status --porcelain")).toBe("");
    expect(tip(repo, "refs/axiom/backup/feature/20261125-150000")).toBe(old);
    expect(r.backupRef).toBe("refs/axiom/backup/feature/20261125-150000");
    expect(ax.getStewardItem(item.id).state).toBe("adopted");
    expect(sh(repo, "git branch --list 'axiom/*'")).toBe("");
    expect(sh(repo, "git worktree list --porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(refs(origin)).toBe(before);
  });

  it("adopt works when the branch is not checked out", async () => {
    const { repo, item } = await copy();
    sh(repo, "git checkout -q main");
    const copyTip = tip(repo, "axiom/rebase/feature");
    await adoptRebase(ax, item.id);
    expect(tip(repo, "feature")).toBe(copyTip);
  });

  it("adopt is refused when the owner's branch moved since the copy", async () => {
    const { repo, item } = await copy();
    writeFileSync(join(repo, "g.txt"), "g");
    sh(repo, "git add -A && git commit -qm newer");
    const t = tip(repo, "feature");
    await expect(adoptRebase(ax, item.id)).rejects.toThrow(/has moved since the copy was made/);
    expect(tip(repo, "feature")).toBe(t);
    expect(ax.getStewardItem(item.id).state).toBe("open");
    expect(sh(repo, "git branch --list 'axiom/rebase/*'")).toContain("axiom/rebase/feature");
  });

  it("adopt is refused when the checkout is dirty", async () => {
    const { repo, item } = await copy();
    writeFileSync(join(repo, "b.txt"), "dirty");
    const t = tip(repo, "feature");
    await expect(adoptRebase(ax, item.id)).rejects.toThrow(/uncommitted changes/);
    expect(tip(repo, "feature")).toBe(t);
    expect(sh(repo, "cat b.txt")).toBe("dirty");
    writeFileSync(join(repo, "b.txt"), "b1\nb2 feature\nb3\n");
    sh(repo, "git checkout -q b.txt");
  });

  it("adopt is refused for an item that is not a rebased copy", async () => {
    setup({});
    const item = ax.addStewardItem({ kind: "suggestion", title: "x" }, steward);
    await expect(adoptRebase(ax, item.id)).rejects.toThrow();
  });

  it("discard removes Steward's branch and worktree and leaves the owner's branch", async () => {
    const { repo, item } = await copy();
    const t = tip(repo, "feature");
    const wt = ax.getStewardSuggestion(item.id).worktree as string;
    expect(existsSync(wt)).toBe(true);
    await discardFix(ax, item.id);
    expect(ax.getStewardItem(item.id).state).toBe("discarded");
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, "git branch --list 'axiom/*'")).toBe("");
    expect(tip(repo, "feature")).toBe(t);
    // a discarded copy is not offered again for the same tips
    writeFileSync(join(repo, "scratch.txt"), "x");
    expect((await freshen()).items).toHaveLength(0);
  });
});
