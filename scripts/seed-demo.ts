/**
 * Fills a database with the demo data of the design mockups (docs/design/mockups/src/data.js),
 * with every time shifted so the mockup's "now" (25 Nov 2026 09:40) is the moment you run it.
 *
 *   node --import tsx scripts/seed-demo.ts --db /tmp/axiom-demo.db
 */
import { parseArgs } from "node:util";
import {
  type Actor,
  type Axiom,
  type EntryKind,
  type LinkKind,
  openDatabase,
  type TopicStatus,
} from "@axiom/core";

const MOCK_NOW = Date.parse("2026-11-25T09:40:00Z");
const owner: Actor = { kind: "owner" };
const axiomActor: Actor = { kind: "axiom" };

type Iso = string;
interface MockThread {
  provider: "t3" | "claude-code";
  id: string;
  title: string;
  status: TopicStatus;
  startedAt: Iso;
  endedAt?: Iso;
  env?: string;
}
interface MockEntry {
  at: Iso;
  author: "agent" | "owner" | "axiom";
  thread?: string;
  kind: EntryKind;
  body?: string;
  data?: unknown;
  refs?: string[];
}
interface MockTopic {
  slug: string;
  title: string;
  status: TopicStatus | null;
  statusNote: string;
  goal?: string;
  epics?: string[];
  tickets?: string[];
  createdAt: Iso;
  lastWorkedAt: Iso;
  muted?: boolean;
  staleDismissed?: boolean;
  threads?: MockThread[];
  links?: { kind: LinkKind; target: string; label?: string }[];
  monitors?: { kind: string; target: string; state: "suggested" | "confirmed" }[];
  entries?: MockEntry[];
}

interface MockWorkItem {
  slug: string;
  title: string;
  status?: "to do" | "wip" | "done";
  jira?: { key: string; status: string };
  epics?: string[];
}

const EPICS: MockWorkItem[] = [
  { slug: "axiom", title: "Axiom", status: "wip" },
  {
    slug: "mtg-next-phase-2",
    title: "MTG next phase 2",
    jira: { key: "MTG-12", status: "In Progress" },
  },
  { slug: "ahoy", title: "AHOY", status: "wip" },
];
const TICKETS: MockWorkItem[] = [
  {
    slug: "mtg-214",
    title: "Wave I: Multiverse Reforged deck gaps (rows 59–67)",
    epics: ["mtg-next-phase-2"],
    jira: { key: "MTG-214", status: "In Progress" },
  },
  {
    slug: "mtg-198",
    title: "Wave H: Commander-deck gaps (rows 53–58)",
    epics: ["mtg-next-phase-2"],
    jira: { key: "MTG-198", status: "In Review" },
  },
  { slug: "ahoy-usability", title: "Usability pass", epics: ["ahoy"], status: "wip" },
];

const TOPICS: MockTopic[] = [
  {
    slug: "axiom-spec",
    title: "Axiom: spec phase",
    status: "hitl",
    statusNote:
      "00, 01, 08 settled; tech agreed (ADRs 0001–0005); 05 drafted; hooks tested; build plan awaiting approval",
    goal: "A settled spec and an agreed build plan for the first tracker version",
    epics: ["axiom"],
    createdAt: "2026-11-25T01:20:00",
    lastWorkedAt: "2026-11-25T09:31:00",
    threads: [
      {
        provider: "t3",
        id: "227205b0",
        title: "Axiom spec",
        status: "hitl",
        startedAt: "2026-11-25T01:18:00",
        env: "vic-desktop",
      },
      {
        provider: "t3",
        id: "thread:delegated-task…b44a",
        title: "Axiom hook test (throwaway)",
        status: "done",
        startedAt: "2026-11-25T09:19:44",
        endedAt: "2026-11-25T09:19:47",
        env: "vic-desktop",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/axiom" },
      { kind: "branch", target: "main" },
      { kind: "spec", target: "docs/spec/README.md", label: "Spec index" },
      { kind: "spec", target: "docs/plan/v1-tracker.md", label: "Build plan" },
      { kind: "artifact", target: "docs/design/references/relay.png", label: "Visual reference" },
    ],
    entries: [
      {
        at: "2026-11-25T09:31:00",
        author: "axiom",
        thread: "227205b0",
        kind: "thread event",
        body: "Waiting on the owner: Settle 04, 05 and 06? Who builds it: this thread or slice threads?",
        data: { event: "waiting on owner" },
      },
      {
        at: "2026-11-25T09:31:00",
        author: "axiom",
        thread: "227205b0",
        kind: "status change",
        data: { from: "wip", to: "hitl", reason: "asked: settle 04, 05, 06 and choose who builds" },
      },
      {
        at: "2026-11-25T09:30:00",
        author: "agent",
        thread: "227205b0",
        kind: "next steps",
        body: "Settle 04, 05, 06; then build S0 (repo scaffold) and S1 (core database and rules).",
      },
      {
        at: "2026-11-25T09:24:00",
        author: "owner",
        kind: "owner input",
        body: "The T3 routing rule looks okay.",
      },
      {
        at: "2026-11-25T09:22:00",
        author: "agent",
        thread: "227205b0",
        kind: "decision",
        body: "T3 is the source of truth for T3 threads. Hook events carrying T3CODE_THREAD_ID only trigger a T3 re-read.",
        data: {
          why: "Hooks fire inside T3-run sessions, so the same thread would be reported twice.",
        },
      },
      {
        at: "2026-11-25T09:20:00",
        author: "agent",
        thread: "227205b0",
        kind: "finding",
        body: "T3-run sessions carry T3CODE_THREAD_ID and CLAUDE_CODE_ENTRYPOINT=t3-code; T3's provider_threads payload holds the Claude session id.",
      },
      {
        at: "2026-11-25T09:19:50",
        author: "agent",
        thread: "227205b0",
        kind: "verification",
        body: "Claude Code hooks fire inside a T3-run thread: SessionStart, UserPromptSubmit, Stop, SessionEnd, at user and project scope.",
        data: { result: "pass" },
        refs: ["thread:delegated-task…b44a"],
      },
      {
        at: "2026-11-25T09:19:44",
        author: "axiom",
        kind: "thread event",
        body: "Thread started: Axiom hook test (throwaway), T3, Haiku 5.5",
      },
      {
        at: "2026-11-25T09:05:00",
        author: "owner",
        kind: "owner input",
        body: "Pin the current version of T3 that Axiom is tested against.",
      },
      {
        at: "2026-11-25T09:04:00",
        author: "agent",
        thread: "227205b0",
        kind: "decision",
        body: "Pinned T3 server 0.1.11-nightly.20261118.4890, database migration 98. Warn on mismatch.",
        refs: ["docs/adr/0005-providers-claude-code-and-t3.md"],
      },
      {
        at: "2026-11-25T08:40:00",
        author: "owner",
        kind: "decision",
        body: "Stack agreed: local server + browser, TypeScript on Node 24, SQLite, CLI writes the database directly.",
      },
      {
        at: "2026-11-25T08:10:00",
        author: "owner",
        kind: "authorization",
        body: "The agent may rebase my branch onto main in place to pick up recent changes. It stays local; I push.",
        data: { scope: "rebase onto main only, clean, no one else pushed", standing: true },
      },
      {
        at: "2026-11-25T07:30:00",
        author: "agent",
        thread: "227205b0",
        kind: "finding",
        body: "Old work log: 4,673 log bullets in 273 topics. Verification ~37%, git/PR ~23%, thread setup ~15%. A quarter to a third is mechanical.",
      },
      {
        at: "2026-11-25T01:25:00",
        author: "agent",
        thread: "227205b0",
        kind: "note",
        body: "Scaffolded ~/projects/axiom: README, AGENTS.md, CONTEXT.md, spec index with sections 00–07, ADR template.",
      },
    ],
  },
  {
    slug: "axiom-mockups",
    title: "Axiom: UI mockups",
    status: "wip",
    statusNote: "Four structurally distinct mockups of the tracker in progress",
    goal: "Pick a visual and structural direction for the first UI (S5)",
    epics: ["axiom"],
    createdAt: "2026-11-25T09:38:00",
    lastWorkedAt: "2026-11-25T09:39:00",
    threads: [
      {
        provider: "t3",
        id: "3c8e9d21",
        title: "Axiom mockups",
        status: "wip",
        startedAt: "2026-11-25T09:38:00",
        env: "vic-desktop",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/axiom" },
      { kind: "spec", target: "docs/spec/09-visual-design.md", label: "Visual design" },
    ],
    entries: [
      {
        at: "2026-11-25T09:39:00",
        author: "owner",
        kind: "owner input",
        body: "Write 4 mockups. They should be structurally distinct, not the same UI with different CSS.",
      },
    ],
  },
  {
    slug: "mtg-wave-i",
    title: "MTG Wave I: Multiverse Reforged deck gaps",
    status: null,
    statusNote: "Rows 59, 60 merged; 61 and 63 running; 62, 64–67 not started",
    goal: "Every card in the Multiverse Reforged decks playable",
    tickets: ["mtg-214"],
    muted: true,
    createdAt: "2026-11-04T02:39:00",
    lastWorkedAt: "2026-11-25T09:37:00",
    threads: [
      {
        provider: "t3",
        id: "a91c2e07",
        title: "Row 61: Ninjutsu",
        status: "wip",
        startedAt: "2026-11-25T08:02:00",
        env: "slopfactory",
      },
      {
        provider: "t3",
        id: "5d3b8f12",
        title: "Row 63: Mutate",
        status: "wip",
        startedAt: "2026-11-25T08:40:00",
        env: "slopfactory",
      },
      {
        provider: "t3",
        id: "0e77aa41",
        title: "Row 60: Ward",
        status: "done",
        startedAt: "2026-11-24T21:10:00",
        endedAt: "2026-11-25T01:52:00",
        env: "slopfactory",
      },
      {
        provider: "claude-code",
        id: "41f3c7e5",
        title: "Row 59 review",
        status: "idle",
        startedAt: "2026-11-24T18:00:00",
        endedAt: "2026-11-24T19:12:00",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/mtg-playground" },
      { kind: "branch", target: "feat/wave-i" },
      { kind: "pr", target: "Advicegale/mtg-playground#203", label: "Row 60: Ward" },
      { kind: "pr", target: "Advicegale/mtg-playground#204", label: "Row 61: Ninjutsu (draft)" },
      { kind: "spec", target: "docs/specs/next-phase-2.md", label: "Next phase 2 spec" },
    ],
    monitors: [{ kind: "pr-checks", target: "Advicegale/mtg-playground#204", state: "confirmed" }],
    entries: [
      {
        at: "2026-11-25T09:37:00",
        author: "agent",
        thread: "a91c2e07",
        kind: "verification",
        body: "Ninjutsu: 1,412 tests, typecheck and build pass; browser check of the return-unblocked flow passes.",
        data: { result: "pass" },
      },
      {
        at: "2026-11-25T09:02:00",
        author: "axiom",
        kind: "git event",
        body: "PR #204 opened (draft), base feat/wave-i, head 3f1a9c2",
        refs: ["Advicegale/mtg-playground#204"],
      },
      {
        at: "2026-11-25T08:40:00",
        author: "axiom",
        kind: "thread event",
        body: "Thread started: Row 63: Mutate (T3, slopfactory)",
      },
      {
        at: "2026-11-25T01:52:00",
        author: "axiom",
        kind: "git event",
        body: "PR #203 merged into feat/wave-i (b7e20d4)",
        refs: ["Advicegale/mtg-playground#203"],
      },
      {
        at: "2026-11-25T01:40:00",
        author: "agent",
        thread: "0e77aa41",
        kind: "finding",
        body: "Ward triggers were checked before targets locked; moved the check to the cast step (CR 702.21a).",
      },
    ],
  },
  {
    slug: "ahoy-usability-audit",
    title: "AHOY usability and design audit",
    status: "review",
    statusNote: "Fixes for B1–B4, M1–M9, S1–S4 in PR #49; web + OTA deploy pending",
    goal: "Every blocker and major from the audit fixed and deployed",
    tickets: ["ahoy-usability"],
    createdAt: "2026-11-20T14:00:00",
    lastWorkedAt: "2026-11-25T09:12:00",
    threads: [
      {
        provider: "claude-code",
        id: "c2d9e310",
        title: "Usability fixes",
        status: "review",
        startedAt: "2026-11-22T10:00:00",
        endedAt: "2026-11-22T18:40:00",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/ahoy" },
      { kind: "worktree", target: "~/projects/ahoy-worktrees/usability-fixes" },
      { kind: "branch", target: "fix/usability-blockers-majors" },
      { kind: "pr", target: "Advicegale/AHOY#49" },
      {
        kind: "artifact",
        target: "https://claude.ai/artifact/LEBNVeDNSgCCHLkptKmrRL",
        label: "Audit report",
      },
    ],
    monitors: [
      { kind: "pr-review", target: "Advicegale/AHOY#49", state: "confirmed" },
      { kind: "pr-checks", target: "Advicegale/AHOY#49", state: "confirmed" },
    ],
    entries: [
      {
        at: "2026-11-25T09:12:00",
        author: "axiom",
        kind: "git event",
        body: "Review on PR #49: approved, 1 comment (meal suggestion copy)",
        refs: ["Advicegale/AHOY#49"],
      },
      {
        at: "2026-11-22T18:40:00",
        author: "axiom",
        thread: "c2d9e310",
        kind: "status change",
        data: { from: "wip", to: "review", reason: "PR #49 ready for review" },
      },
      {
        at: "2026-11-22T18:30:00",
        author: "agent",
        thread: "c2d9e310",
        kind: "verification",
        body: "All screens re-checked at 390 px and desktop; 2 date-dependent tests fail on main, unrelated.",
        data: { result: "partial" },
      },
    ],
  },
  {
    slug: "atlas-coolify-deployment",
    title: "Atlas Coolify deployment",
    status: "monitoring",
    statusNote: "Redeployed after the LAN IP drift; watching the health check",
    createdAt: "2026-10-03T18:36:00",
    lastWorkedAt: "2026-11-25T08:20:00",
    threads: [
      {
        provider: "claude-code",
        id: "77b0c1aa",
        title: "Coolify redeploy",
        status: "monitoring",
        startedAt: "2026-11-25T07:50:00",
        endedAt: "2026-11-25T08:20:00",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/atlas-trip-planner" },
      { kind: "branch", target: "main" },
      { kind: "artifact", target: "atlas.vicegale.com", label: "Production site" },
      { kind: "pr", target: "Advicegale/atlas#88" },
    ],
    monitors: [
      { kind: "deploy-health", target: "atlas.vicegale.com", state: "confirmed" },
      { kind: "pr-checks", target: "Advicegale/atlas#88", state: "suggested" },
    ],
    entries: [
      {
        at: "2026-11-25T09:15:00",
        author: "axiom",
        kind: "deploy event",
        body: "Health check slow: 2.3 s (threshold 1.5 s)",
      },
      {
        at: "2026-11-25T08:20:00",
        author: "axiom",
        kind: "deploy event",
        body: "Deployed main@25bd644 to atlas.vicegale.com",
      },
    ],
  },
  {
    slug: "casa-clara-math-review",
    title: "Casa Clara: math audit and UI review",
    status: "blocked",
    statusNote: "Real FINEs show a ~1.2 pp TAEG gap; waiting on the bank's FINE documents",
    createdAt: "2026-11-19T10:00:00",
    lastWorkedAt: "2026-11-20T17:00:00",
    threads: [
      {
        provider: "claude-code",
        id: "9f00b2c4",
        title: "FINE parser",
        status: "blocked",
        startedAt: "2026-11-20T09:00:00",
        endedAt: "2026-11-20T17:00:00",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/Casa-Clara-Portugal-v3" },
      { kind: "branch", target: "feat/fine-parser" },
    ],
    entries: [
      {
        at: "2026-11-20T17:00:00",
        author: "axiom",
        thread: "9f00b2c4",
        kind: "status change",
        data: { from: "wip", to: "blocked", reason: "needs the bank's FINE documents" },
      },
    ],
  },
  {
    slug: "godot-vr-test",
    title: "Godot VR test (Quest via Steam Link)",
    status: "wip",
    statusNote: "Tuning the grapple course; rope solver capped at 6 m/s",
    createdAt: "2026-11-05T20:00:00",
    lastWorkedAt: "2026-11-25T09:36:00",
    threads: [
      {
        provider: "claude-code",
        id: "e1c4d5f0",
        title: "Grapple course",
        status: "wip",
        startedAt: "2026-11-25T09:10:00",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/vr-test" },
      { kind: "spec", target: "docs/specs/station.md", label: "Station spec" },
    ],
    entries: [
      {
        at: "2026-11-25T09:36:00",
        author: "agent",
        thread: "e1c4d5f0",
        kind: "finding",
        body: "Rope snapping came from capping the whole velocity; cap only the carried part.",
      },
    ],
  },
  {
    slug: "prism-v02",
    title: "Prism v0.2 development",
    status: "error",
    statusNote: "Thread crashed while regenerating the graph",
    createdAt: "2026-10-12T17:06:00",
    lastWorkedAt: "2026-11-25T08:55:00",
    threads: [
      {
        provider: "t3",
        id: "c0ffee21",
        title: "Graph regen",
        status: "error",
        startedAt: "2026-11-25T08:30:00",
        endedAt: "2026-11-25T08:55:00",
        env: "vic-desktop",
      },
    ],
    links: [{ kind: "repository", target: "~/projects/prism/prism-pr-review" }],
    entries: [
      {
        at: "2026-11-25T08:55:00",
        author: "axiom",
        thread: "c0ffee21",
        kind: "thread event",
        body: "Thread error: Provider process exited (code 1) during graph regeneration",
        data: { event: "error" },
      },
    ],
  },
  {
    slug: "twitch-drops-headless",
    title: "Twitch Drops Miner headless on Coolify",
    status: "idle",
    statusNote: "Docker packaging written locally, untested",
    createdAt: "2026-11-03T21:00:00",
    lastWorkedAt: "2026-11-04T01:10:00",
    threads: [
      {
        provider: "claude-code",
        id: "1aa2bb3c",
        title: "Docker packaging",
        status: "idle",
        startedAt: "2026-11-03T21:00:00",
        endedAt: "2026-11-04T01:10:00",
      },
    ],
    links: [{ kind: "repository", target: "~/Documents/notes/TwitchDropsMiner" }],
  },
  {
    slug: "swe-test",
    title: "SWE aptitude diagnostic test",
    status: "idle",
    statusNote: "v1 done + interactive web page; repo uncommitted",
    createdAt: "2026-11-24T19:05:00",
    lastWorkedAt: "2026-11-24T22:41:00",
    threads: [
      {
        provider: "t3",
        id: "5e57e5t0",
        title: "SWE test",
        status: "idle",
        startedAt: "2026-11-24T19:05:00",
        endedAt: "2026-11-24T22:41:00",
        env: "vic-desktop",
      },
    ],
    links: [
      { kind: "repository", target: "~/projects/swe-test" },
      {
        kind: "artifact",
        target: "https://claude.ai/artifact/SFrybe3njb9VxPGRPa8eQZ",
        label: "Test page",
      },
    ],
  },
  {
    slug: "mtg-deckbuilder-spec",
    title: "MTG deckbuilder environment",
    status: "idle",
    statusNote: "Spec v1.1; 5 open decisions",
    epics: ["mtg-next-phase-2"],
    createdAt: "2026-10-20T12:00:00",
    lastWorkedAt: "2026-10-25T16:00:00",
    staleDismissed: true,
  },
  {
    slug: "mtg-wave-h",
    title: "MTG Wave H orchestration",
    status: "stale",
    statusNote: "Rows 53–56 merged; 57–58 not started",
    tickets: ["mtg-198"],
    muted: true,
    createdAt: "2026-11-01T10:00:00",
    lastWorkedAt: "2026-11-03T22:00:00",
  },
  {
    slug: "mtg-commander-takeover",
    title: "MTG PRs #163/#164 takeover",
    status: "review",
    statusNote: "Fixes pushed to both PRs; awaiting merge",
    epics: ["mtg-next-phase-2"],
    createdAt: "2026-10-30T09:00:00",
    lastWorkedAt: "2026-10-30T23:00:00",
    links: [
      { kind: "pr", target: "Advicegale/mtg-playground#163" },
      { kind: "pr", target: "Advicegale/mtg-playground#164" },
    ],
    monitors: [{ kind: "pr-review", target: "Advicegale/mtg-playground#163", state: "confirmed" }],
  },
  {
    slug: "mtg-scryfall-cache",
    title: "MTG Scryfall cache / faster game start",
    status: "done",
    statusNote: "Merged #147; start 8.1 s → 0.5 s",
    epics: ["mtg-next-phase-2"],
    createdAt: "2026-10-27T09:00:00",
    lastWorkedAt: "2026-10-27T18:00:00",
  },
  {
    slug: "mtg-fps-counter",
    title: "MTG FPS counter / performance pass",
    status: "done",
    statusNote: "Merged #177",
    createdAt: "2026-11-01T09:00:00",
    lastWorkedAt: "2026-11-01T20:00:00",
  },
  {
    slug: "mtg-pwa-install",
    title: "MTG installable + fullscreen on Android",
    status: "done",
    statusNote: "Merged #126; deployed",
    createdAt: "2026-10-26T09:00:00",
    lastWorkedAt: "2026-10-26T15:00:00",
  },
];

const NOTIFICATIONS = [
  {
    topic: "swe-test",
    kind: "agent stopped",
    at: "2026-11-24T22:41:00",
    body: "Thread SWE test went idle",
  },
  {
    topic: "mtg-wave-i",
    kind: "jira changed",
    at: "2026-11-24T23:02:00",
    body: "MTG-214: To Do → In Progress",
  },
  {
    topic: "prism-v02",
    kind: "error",
    at: "2026-11-25T08:55:00",
    body: "Provider process exited (code 1)",
  },
  {
    topic: "ahoy-usability-audit",
    kind: "pr review",
    at: "2026-11-25T09:12:00",
    body: "PR #49 approved, 1 comment",
  },
  {
    topic: "atlas-coolify-deployment",
    kind: "monitor problem",
    at: "2026-11-25T09:15:00",
    body: "Health check slow: 2.3 s",
  },
  {
    topic: "mtg-wave-i",
    kind: "agent stopped",
    at: "2026-11-25T09:20:00",
    body: "Row 60: Ward finished",
  },
  {
    topic: "axiom-spec",
    kind: "agent asked",
    at: "2026-11-25T09:31:00",
    body: "Settle 04, 05 and 06? Who builds it?",
  },
] as const;

function run(ax: Axiom, setNow: (t: number) => void, shift: number): void {
  const t = (mock: Iso): number => Date.parse(`${mock}Z`) + shift;
  const iso = (mock: Iso): string => new Date(t(mock)).toISOString();
  const at = (mock: Iso): void => setNow(t(mock));

  at("2026-10-01T00:00:00");
  const jiraOf = (j: MockWorkItem["jira"]) =>
    j ? { key: j.key, url: `https://example.atlassian.net/browse/${j.key}` } : undefined;
  for (const e of EPICS) {
    ax.createEpic({ slug: e.slug, title: e.title, status: e.status, jira: jiraOf(e.jira) }, owner);
    if (e.jira) ax.setEpicJiraStatus(e.slug, e.jira.status);
  }
  for (const k of TICKETS) {
    ax.createTicket(
      { slug: k.slug, title: k.title, status: k.status, jira: jiraOf(k.jira) },
      owner,
    );
    if (k.jira) ax.setTicketJiraStatus(k.slug, k.jira.status);
    for (const e of k.epics ?? []) ax.addTicketToEpic(k.slug, e, owner);
  }

  for (const m of TOPICS) {
    at(m.createdAt);
    ax.createTopic(
      {
        slug: m.slug,
        title: m.title,
        goal: m.goal,
        statusNote: m.statusNote,
        status: m.status ?? "idle",
      },
      owner,
    );
    for (const e of m.epics ?? []) ax.addTopicToEpic(m.slug, e, owner);
    for (const k of m.tickets ?? []) ax.addTopicToTicket(m.slug, k, owner);

    const threadIds = new Map<string, number>();
    for (const th of m.threads ?? []) {
      at(th.startedAt);
      const row = ax.attachThread(
        m.slug,
        {
          provider: th.provider,
          providerThreadId: th.id,
          environmentId: th.env ?? null,
          title: th.title,
        },
        owner,
      );
      threadIds.set(th.id, row.id);
      // The demo needs threads in given states without running the events that lead there.
      ax.db
        .prepare("UPDATE thread SET status = ?, status_changed_at = ?, ended_at = ? WHERE id = ?")
        .run(
          th.status,
          iso(th.endedAt ?? th.startedAt),
          th.endedAt ? iso(th.endedAt) : null,
          row.id,
        );
    }
    if (m.status === null)
      ax.db.prepare("UPDATE topic SET status = NULL WHERE slug = ?").run(m.slug);

    const linkIds = new Map<string, number>();
    for (const l of m.links ?? []) {
      at(m.createdAt);
      linkIds.set(l.target, ax.addLink(m.slug, l, owner).id);
    }
    for (const mon of m.monitors ?? []) {
      ax.addMonitorTarget(
        m.slug,
        { kind: mon.kind, linkId: linkIds.get(mon.target), state: mon.state },
        owner,
      );
    }

    const entries = [...(m.entries ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    for (const e of entries) {
      at(e.at);
      const threadId = e.thread ? threadIds.get(e.thread) : undefined;
      const actor: Actor =
        e.author === "owner"
          ? owner
          : e.author === "axiom"
            ? axiomActor
            : { kind: "agent", threadId };
      const row = ax.addEntry(
        m.slug,
        {
          kind: e.kind,
          body: e.body,
          data: e.data,
          refs: e.refs?.map((value) => ({ type: refType(value), value })),
        },
        actor,
      );
      // Axiom's own entries still belong to a thread when the mock names one.
      if (e.author === "axiom" && threadId !== undefined) {
        ax.db.prepare("UPDATE entry SET thread_id = ? WHERE id = ?").run(threadId, row.id);
      }
    }
    ax.db
      .prepare(
        "UPDATE topic SET last_worked_at = ?, muted = ?, status = CASE WHEN ? THEN NULL ELSE status END WHERE slug = ?",
      )
      .run(iso(m.lastWorkedAt), m.muted ? 1 : 0, m.status === null ? 1 : 0, m.slug);
    if (m.staleDismissed) ax.dismissStalePrompt(m.slug, owner);
  }

  for (const n of NOTIFICATIONS) {
    at(n.at);
    ax.raiseNotification(n.topic, n.kind, n.body, axiomActor);
  }
  ax.setSetting("mutedKinds", ["jira changed"], owner);
  // The stale prompt for the topic that has been idle since 4 Nov.
  setNow(t("2026-11-25T09:40:00"));
  ax.refreshStalePrompts();
}

function refType(value: string): "pr" | "thread" | "spec" {
  if (value.startsWith("thread:")) return "thread";
  if (value.includes("#")) return "pr";
  return "spec";
}

function main(): void {
  const { values } = parseArgs({ options: { db: { type: "string" }, force: { type: "boolean" } } });
  if (!values.db) {
    console.error("usage: node --import tsx scripts/seed-demo.ts --db <path>");
    process.exit(2);
  }
  let current = Date.now();
  const ax = openDatabase(values.db, { now: () => new Date(current) });
  try {
    const existing = ax.listTopics().length;
    if (existing > 0) {
      console.error(`${values.db} already holds ${existing} topics; use an empty database.`);
      process.exit(1);
    }
    run(
      ax,
      (ms) => {
        current = ms;
      },
      Date.now() - MOCK_NOW,
    );
    console.log(`Seeded ${values.db} with ${ax.listTopics().length} topics.`);
  } finally {
    ax.close();
  }
}

main();
