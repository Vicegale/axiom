// Shared sample data for the Axiom mockups. Realistic, taken from the owner's work log.
// "Now" is 2026-11-25 09:40 (Lisbon). Only features from the settled spec appear here.
window.AXIOM = {
  now: "2026-11-25T09:40:00",
  statuses: {
    idle:       { label: "idle",       meaning: "Nothing is happening" },
    wip:        { label: "wip",        meaning: "An agent is working" },
    hitl:       { label: "hitl",       meaning: "Waiting for you" },
    monitoring: { label: "monitoring", meaning: "Waiting on something the agent watches" },
    blocked:    { label: "blocked",    meaning: "Waiting on something the agent can't watch" },
    review:     { label: "review",     meaning: "A PR is in review" },
    done:       { label: "done",       meaning: "No actions left" },
    stale:      { label: "stale",      meaning: "You marked it stale" },
    error:      { label: "error",      meaning: "The agent's thread hit an error" }
  },
  // The tracker views (01). idle / blocked / stale are their own piles; done is closed.
  views: [
    { id: "attention",  label: "Requires attention", statuses: ["hitl", "error"] },
    { id: "ongoing",    label: "Ongoing",            statuses: ["wip"] },
    { id: "monitoring", label: "Under monitoring",   statuses: ["monitoring", "review"] }
  ],
  piles: ["idle", "blocked", "stale", "done"],
  entryKinds: {
    "note":          { by: "agent|owner", label: "NOTE" },
    "decision":      { by: "agent|owner", label: "DECIDED" },
    "finding":       { by: "agent|owner", label: "FOUND" },
    "verification":  { by: "agent|owner", label: "CHECKED" },
    "owner input":   { by: "owner",       label: "YOU SAID" },
    "authorization": { by: "owner",       label: "YOU ALLOWED" },
    "next steps":    { by: "agent|owner", label: "NEXT" },
    "status change": { by: "axiom",       label: "STATUS" },
    "topic created": { by: "axiom",       label: "CREATED" },
    "thread event":  { by: "axiom",       label: "THREAD" },
    "git event":     { by: "axiom",       label: "GIT" },
    "deploy event":  { by: "axiom",       label: "DEPLOY" }
  },
  epics: [
    { slug: "axiom", title: "Axiom", status: "wip", jira: null },
    { slug: "mtg-next-phase-2", title: "MTG next phase 2", jira: { key: "MTG-12", status: "In Progress" } },
    { slug: "ahoy", title: "AHOY", status: "wip", jira: null }
  ],
  tickets: [
    { slug: "mtg-214", title: "Wave I: Multiverse Reforged deck gaps (rows 59–67)", epics: ["mtg-next-phase-2"], jira: { key: "MTG-214", status: "In Progress" } },
    { slug: "mtg-198", title: "Wave H: Commander-deck gaps (rows 53–58)", epics: ["mtg-next-phase-2"], jira: { key: "MTG-198", status: "In Review" } },
    { slug: "ahoy-usability", title: "Usability pass", epics: ["ahoy"], status: "wip", jira: null }
  ],
  topics: [
    {
      slug: "axiom-spec", title: "Axiom: spec phase", status: "hitl",
      statusNote: "00, 01, 08 settled; tech agreed (ADRs 0001–0005); 05 drafted; hooks tested; build plan awaiting approval",
      goal: "A settled spec and an agreed build plan for the first tracker version",
      parents: { epics: ["axiom"], tickets: [] },
      createdAt: "2026-11-25T01:20:00", lastWorkedAt: "2026-11-25T09:31:00",
      attention: { reason: "agent asked", text: "Settle 04, 05 and 06? Who builds it: this thread or slice threads?" },
      unread: true, muted: false,
      threads: [
        { provider: "t3", id: "227205b0", title: "Axiom spec", status: "hitl", startedAt: "2026-11-25T01:18:00", env: "vic-desktop" },
        { provider: "t3", id: "thread:delegated-task…b44a", title: "Axiom hook test (throwaway)", status: "done", startedAt: "2026-11-25T09:19:44", endedAt: "2026-11-25T09:19:47", env: "vic-desktop" }
      ],
      links: [
        { kind: "repository", target: "~/projects/axiom" },
        { kind: "branch", target: "main" },
        { kind: "spec", target: "docs/spec/README.md", label: "Spec index" },
        { kind: "spec", target: "docs/plan/v1-tracker.md", label: "Build plan" },
        { kind: "artifact", target: "docs/design/references/relay.png", label: "Visual reference" }
      ],
      monitors: [],
      entries: [
        { at: "2026-11-25T09:31:00", author: "agent", thread: "227205b0", kind: "status change", data: { from: "wip", to: "hitl", reason: "asked: settle 04, 05, 06 and choose who builds" } },
        { at: "2026-11-25T09:30:00", author: "agent", thread: "227205b0", kind: "next steps", body: "Settle 04, 05, 06; then build S0 (repo scaffold) and S1 (core database and rules)." },
        { at: "2026-11-25T09:24:00", author: "owner", kind: "owner input", body: "The T3 routing rule looks okay." },
        { at: "2026-11-25T09:22:00", author: "agent", thread: "227205b0", kind: "decision", body: "T3 is the source of truth for T3 threads. Hook events carrying T3CODE_THREAD_ID only trigger a T3 re-read.", data: { why: "Hooks fire inside T3-run sessions, so the same thread would be reported twice." } },
        { at: "2026-11-25T09:20:00", author: "agent", thread: "227205b0", kind: "finding", body: "T3-run sessions carry T3CODE_THREAD_ID and CLAUDE_CODE_ENTRYPOINT=t3-code; T3's provider_threads payload holds the Claude session id." },
        { at: "2026-11-25T09:19:50", author: "agent", thread: "227205b0", kind: "verification", body: "Claude Code hooks fire inside a T3-run thread: SessionStart, UserPromptSubmit, Stop, SessionEnd, at user and project scope.", data: { result: "pass" }, refs: ["thread:delegated-task…b44a"] },
        { at: "2026-11-25T09:19:44", author: "axiom", kind: "thread event", body: "Thread started: Axiom hook test (throwaway), T3, Haiku 5.5" },
        { at: "2026-11-25T09:05:00", author: "owner", kind: "owner input", body: "Pin the current version of T3 that Axiom is tested against." },
        { at: "2026-11-25T09:04:00", author: "agent", thread: "227205b0", kind: "decision", body: "Pinned T3 server 0.1.11-nightly.20261118.4890, database migration 98. Warn on mismatch.", refs: ["docs/adr/0005-providers-claude-code-and-t3.md"] },
        { at: "2026-11-25T08:40:00", author: "owner", kind: "decision", body: "Stack agreed: local server + browser, TypeScript on Node 24, SQLite, CLI writes the database directly." },
        { at: "2026-11-25T08:10:00", author: "owner", kind: "authorization", body: "The agent may rebase my branch onto main in place to pick up recent changes. It stays local; I push.", data: { scope: "rebase onto main only, clean, no one else pushed", standing: true } },
        { at: "2026-11-25T07:30:00", author: "agent", thread: "227205b0", kind: "finding", body: "Old work log: 4,673 log bullets in 273 topics. Verification ~37%, git/PR ~23%, thread setup ~15%. A quarter to a third is mechanical." },
        { at: "2026-11-25T01:25:00", author: "agent", thread: "227205b0", kind: "note", body: "Scaffolded ~/projects/axiom: README, AGENTS.md, CONTEXT.md, spec index with sections 00–07, ADR template." },
        { at: "2026-11-25T01:20:00", author: "axiom", kind: "topic created" }
      ]
    },
    {
      slug: "axiom-mockups", title: "Axiom: UI mockups", status: "wip",
      statusNote: "Four structurally distinct mockups of the tracker in progress",
      goal: "Pick a visual and structural direction for the first UI (S5)",
      parents: { epics: ["axiom"], tickets: [] },
      createdAt: "2026-11-25T09:38:00", lastWorkedAt: "2026-11-25T09:39:00",
      unread: false, muted: false,
      threads: [ { provider: "t3", id: "3c8e9d21", title: "Axiom mockups", status: "wip", startedAt: "2026-11-25T09:38:00", env: "vic-desktop" } ],
      links: [ { kind: "repository", target: "~/projects/axiom" }, { kind: "spec", target: "docs/spec/09-visual-design.md", label: "Visual design" } ],
      monitors: [],
      entries: [
        { at: "2026-11-25T09:39:00", author: "owner", kind: "owner input", body: "Write 4 mockups. They should be structurally distinct, not the same UI with different CSS." },
        { at: "2026-11-25T09:38:00", author: "axiom", kind: "topic created" }
      ]
    },
    {
      slug: "mtg-wave-i", title: "MTG Wave I: Multiverse Reforged deck gaps", status: null,
      statusNote: "Rows 59, 60 merged; 61 and 63 running; 62, 64–67 not started",
      goal: "Every card in the Multiverse Reforged decks playable",
      parents: { epics: [], tickets: ["mtg-214"] },
      createdAt: "2026-11-04T02:39:00", lastWorkedAt: "2026-11-25T09:37:00",
      unread: true, muted: true,
      threads: [
        { provider: "t3", id: "a91c2e07", title: "Row 61: Ninjutsu", status: "wip", startedAt: "2026-11-25T08:02:00", env: "slopfactory" },
        { provider: "t3", id: "5d3b8f12", title: "Row 63: Mutate", status: "wip", startedAt: "2026-11-25T08:40:00", env: "slopfactory" },
        { provider: "t3", id: "0e77aa41", title: "Row 60: Ward", status: "done", startedAt: "2026-11-24T21:10:00", endedAt: "2026-11-25T01:52:00", env: "slopfactory" },
        { provider: "claude-code", id: "41f3c7e5", title: "Row 59 review", status: "idle", startedAt: "2026-11-24T18:00:00", endedAt: "2026-11-24T19:12:00" }
      ],
      links: [
        { kind: "repository", target: "~/projects/mtg-playground" },
        { kind: "branch", target: "feat/wave-i" },
        { kind: "pr", target: "Advicegale/mtg-playground#203", label: "Row 60: Ward" },
        { kind: "pr", target: "Advicegale/mtg-playground#204", label: "Row 61: Ninjutsu (draft)" },
        { kind: "spec", target: "docs/specs/next-phase-2.md", label: "Next phase 2 spec" }
      ],
      monitors: [ { kind: "pr-checks", target: "Advicegale/mtg-playground#204", state: "confirmed" } ],
      entries: [
        { at: "2026-11-25T09:37:00", author: "agent", thread: "a91c2e07", kind: "verification", body: "Ninjutsu: 1,412 tests, typecheck and build pass; browser check of the return-unblocked flow passes.", data: { result: "pass" } },
        { at: "2026-11-25T09:02:00", author: "axiom", kind: "git event", body: "PR #204 opened (draft), base feat/wave-i, head 3f1a9c2", refs: ["Advicegale/mtg-playground#204"] },
        { at: "2026-11-25T08:40:00", author: "axiom", kind: "thread event", body: "Thread started: Row 63: Mutate (T3, slopfactory)" },
        { at: "2026-11-25T01:52:00", author: "axiom", kind: "git event", body: "PR #203 merged into feat/wave-i (b7e20d4)", refs: ["Advicegale/mtg-playground#203"] },
        { at: "2026-11-25T01:40:00", author: "agent", thread: "0e77aa41", kind: "finding", body: "Ward triggers were checked before targets locked; moved the check to the cast step (CR 702.21a)." }
      ]
    },
    {
      slug: "ahoy-usability-audit", title: "AHOY usability and design audit", status: "review",
      statusNote: "Fixes for B1–B4, M1–M9, S1–S4 in PR #49; web + OTA deploy pending",
      goal: "Every blocker and major from the audit fixed and deployed",
      parents: { epics: [], tickets: ["ahoy-usability"] },
      createdAt: "2026-11-20T14:00:00", lastWorkedAt: "2026-11-25T09:12:00",
      unread: true, muted: false,
      threads: [ { provider: "claude-code", id: "c2d9e310", title: "Usability fixes", status: "review", startedAt: "2026-11-22T10:00:00", endedAt: "2026-11-22T18:40:00" } ],
      links: [
        { kind: "repository", target: "~/projects/ahoy" },
        { kind: "worktree", target: "~/projects/ahoy-worktrees/usability-fixes" },
        { kind: "branch", target: "fix/usability-blockers-majors" },
        { kind: "pr", target: "Advicegale/AHOY#49" },
        { kind: "artifact", target: "https://claude.ai/artifact/LEBNVeDNSgCCHLkptKmrRL", label: "Audit report" }
      ],
      monitors: [
        { kind: "pr-review", target: "Advicegale/AHOY#49", state: "confirmed" },
        { kind: "pr-checks", target: "Advicegale/AHOY#49", state: "confirmed" }
      ],
      entries: [
        { at: "2026-11-25T09:12:00", author: "axiom", kind: "git event", body: "Review on PR #49: approved, 1 comment (meal suggestion copy)", refs: ["Advicegale/AHOY#49"] },
        { at: "2026-11-22T18:40:00", author: "agent", thread: "c2d9e310", kind: "status change", data: { from: "wip", to: "review", reason: "PR #49 ready for review" } },
        { at: "2026-11-22T18:30:00", author: "agent", thread: "c2d9e310", kind: "verification", body: "All screens re-checked at 390 px and desktop; 2 date-dependent tests fail on main, unrelated.", data: { result: "partial" } }
      ]
    },
    {
      slug: "atlas-coolify-deployment", title: "Atlas Coolify deployment", status: "monitoring",
      statusNote: "Redeployed after the LAN IP drift; watching the health check",
      parents: { epics: [], tickets: [] },
      createdAt: "2026-10-03T18:36:00", lastWorkedAt: "2026-11-25T08:20:00",
      unread: true, muted: false,
      threads: [ { provider: "claude-code", id: "77b0c1aa", title: "Coolify redeploy", status: "monitoring", startedAt: "2026-11-25T07:50:00", endedAt: "2026-11-25T08:20:00" } ],
      links: [ { kind: "repository", target: "~/projects/atlas-trip-planner" }, { kind: "branch", target: "main" } ],
      monitors: [ { kind: "deploy-health", target: "atlas.vicegale.com", state: "confirmed" }, { kind: "pr-checks", target: "Advicegale/atlas#88", state: "suggested" } ],
      entries: [
        { at: "2026-11-25T09:15:00", author: "axiom", kind: "deploy event", body: "Health check slow: 2.3 s (threshold 1.5 s)" },
        { at: "2026-11-25T08:20:00", author: "axiom", kind: "deploy event", body: "Deployed main@25bd644 to atlas.vicegale.com" }
      ]
    },
    {
      slug: "casa-clara-math-review", title: "Casa Clara: math audit and UI review", status: "blocked",
      statusNote: "Real FINEs show a ~1.2 pp TAEG gap; waiting on the bank's FINE documents",
      parents: { epics: [], tickets: [] },
      createdAt: "2026-11-19T10:00:00", lastWorkedAt: "2026-11-20T17:00:00",
      unread: false, muted: false,
      threads: [ { provider: "claude-code", id: "9f00b2c4", title: "FINE parser", status: "blocked", startedAt: "2026-11-20T09:00:00", endedAt: "2026-11-20T17:00:00" } ],
      links: [ { kind: "repository", target: "~/projects/Casa-Clara-Portugal-v3" }, { kind: "branch", target: "feat/fine-parser" } ],
      monitors: [],
      entries: [ { at: "2026-11-20T17:00:00", author: "agent", thread: "9f00b2c4", kind: "status change", data: { from: "wip", to: "blocked", reason: "needs the bank's FINE documents" } } ]
    },
    {
      slug: "godot-vr-test", title: "Godot VR test (Quest via Steam Link)", status: "wip",
      statusNote: "Tuning the grapple course; rope solver capped at 6 m/s",
      parents: { epics: [], tickets: [] },
      createdAt: "2026-11-05T20:00:00", lastWorkedAt: "2026-11-25T09:36:00",
      unread: false, muted: false,
      threads: [ { provider: "claude-code", id: "e1c4d5f0", title: "Grapple course", status: "wip", startedAt: "2026-11-25T09:10:00" } ],
      links: [ { kind: "repository", target: "~/projects/vr-test" }, { kind: "spec", target: "docs/specs/station.md", label: "Station spec" } ],
      monitors: [],
      entries: [ { at: "2026-11-25T09:36:00", author: "agent", thread: "e1c4d5f0", kind: "finding", body: "Rope snapping came from capping the whole velocity; cap only the carried part." } ]
    },
    {
      slug: "prism-v02", title: "Prism v0.2 development", status: "error",
      statusNote: "Thread crashed while regenerating the graph",
      parents: { epics: [], tickets: [] },
      createdAt: "2026-10-12T17:06:00", lastWorkedAt: "2026-11-25T08:55:00",
      attention: { reason: "error", text: "Provider process exited (code 1) during graph regeneration" },
      unread: true, muted: false,
      threads: [ { provider: "t3", id: "c0ffee21", title: "Graph regen", status: "error", startedAt: "2026-11-25T08:30:00", endedAt: "2026-11-25T08:55:00", env: "vic-desktop" } ],
      links: [ { kind: "repository", target: "~/projects/prism/prism-pr-review" } ],
      monitors: [],
      entries: [ { at: "2026-11-25T08:55:00", author: "axiom", kind: "thread event", body: "Thread ended with an error: provider process exited (code 1)" } ]
    },
    {
      slug: "twitch-drops-headless", title: "Twitch Drops Miner headless on Coolify", status: "idle",
      statusNote: "Docker packaging written locally, untested",
      parents: { epics: [], tickets: [] },
      createdAt: "2026-11-03T21:00:00", lastWorkedAt: "2026-11-04T01:10:00",
      stalePrompt: true, unread: true, muted: false,
      threads: [ { provider: "claude-code", id: "1aa2bb3c", title: "Docker packaging", status: "idle", startedAt: "2026-11-03T21:00:00", endedAt: "2026-11-04T01:10:00" } ],
      links: [ { kind: "repository", target: "~/Documents/notes/TwitchDropsMiner" } ], monitors: [], entries: []
    },
    {
      slug: "swe-test", title: "SWE aptitude diagnostic test", status: "idle",
      statusNote: "v1 done + interactive web page; repo uncommitted",
      parents: { epics: [], tickets: [] },
      createdAt: "2026-11-24T19:05:00", lastWorkedAt: "2026-11-24T22:41:00",
      unread: true, muted: false,
      threads: [ { provider: "t3", id: "5e57e5t0", title: "SWE test", status: "idle", startedAt: "2026-11-24T19:05:00", endedAt: "2026-11-24T22:41:00", env: "vic-desktop" } ],
      links: [ { kind: "repository", target: "~/projects/swe-test" }, { kind: "artifact", target: "https://claude.ai/artifact/SFrybe3njb9VxPGRPa8eQZ", label: "Test page" } ],
      monitors: [], entries: []
    },
    {
      slug: "mtg-deckbuilder-spec", title: "MTG deckbuilder environment", status: "idle",
      statusNote: "Spec v1.1; 5 open decisions", parents: { epics: ["mtg-next-phase-2"], tickets: [] },
      createdAt: "2026-10-20T12:00:00", lastWorkedAt: "2026-10-25T16:00:00",
      staleDismissed: true, unread: false, muted: false, threads: [], links: [], monitors: [], entries: []
    },
    {
      slug: "mtg-wave-h", title: "MTG Wave H orchestration", status: "stale",
      statusNote: "Rows 53–56 merged; 57–58 not started", parents: { epics: [], tickets: ["mtg-198"] },
      createdAt: "2026-11-01T10:00:00", lastWorkedAt: "2026-11-03T22:00:00",
      unread: false, muted: true, threads: [], links: [], monitors: [], entries: []
    },
    { slug: "mtg-commander-takeover", title: "MTG PRs #163/#164 takeover", status: "review", statusNote: "Fixes pushed to both PRs; awaiting merge", parents: { epics: ["mtg-next-phase-2"], tickets: [] }, createdAt: "2026-10-30T09:00:00", lastWorkedAt: "2026-10-30T23:00:00", unread: false, muted: false, threads: [], links: [ { kind: "pr", target: "Advicegale/mtg-playground#163" }, { kind: "pr", target: "Advicegale/mtg-playground#164" } ], monitors: [ { kind: "pr-review", target: "Advicegale/mtg-playground#163", state: "confirmed" } ], entries: [] },
    { slug: "mtg-scryfall-cache", title: "MTG Scryfall cache / faster game start", status: "done", statusNote: "Merged #147; start 8.1 s → 0.5 s", parents: { epics: ["mtg-next-phase-2"], tickets: [] }, createdAt: "2026-10-27T09:00:00", lastWorkedAt: "2026-10-27T18:00:00", unread: false, muted: false, threads: [], links: [], monitors: [], entries: [] },
    { slug: "mtg-fps-counter", title: "MTG FPS counter / performance pass", status: "done", statusNote: "Merged #177", parents: { epics: [], tickets: [] }, createdAt: "2026-11-01T09:00:00", lastWorkedAt: "2026-11-01T20:00:00", unread: false, muted: false, threads: [], links: [], monitors: [], entries: [] },
    { slug: "mtg-pwa-install", title: "MTG installable + fullscreen on Android", status: "done", statusNote: "Merged #126; deployed", parents: { epics: [], tickets: [] }, createdAt: "2026-10-26T09:00:00", lastWorkedAt: "2026-10-26T15:00:00", unread: false, muted: false, threads: [], links: [], monitors: [], entries: [] }
  ],
  notifications: [
    { id: 1, topic: "axiom-spec",              kind: "agent asked",     at: "2026-11-25T09:31:00", body: "Settle 04, 05 and 06? Who builds it?" },
    { id: 2, topic: "mtg-wave-i",              kind: "agent stopped",   at: "2026-11-25T09:20:00", body: "Row 60: Ward finished", muted: true },
    { id: 3, topic: "atlas-coolify-deployment", kind: "monitor problem", at: "2026-11-25T09:15:00", body: "Health check slow: 2.3 s" },
    { id: 4, topic: "ahoy-usability-audit",    kind: "pr review",       at: "2026-11-25T09:12:00", body: "PR #49 approved, 1 comment" },
    { id: 5, topic: "prism-v02",               kind: "error",           at: "2026-11-25T08:55:00", body: "Provider process exited (code 1)" },
    { id: 6, topic: "twitch-drops-headless",   kind: "stale prompt",    at: "2026-11-25T08:00:00", body: "Idle for 21 days. Mark as stale?" },
    { id: 7, topic: "mtg-wave-i",              kind: "jira changed",    at: "2026-11-24T23:02:00", body: "MTG-214: To Do → In Progress", muted: true },
    { id: 8, topic: "swe-test",                kind: "agent stopped",   at: "2026-11-24T22:41:00", body: "Thread SWE test went idle" }
  ],
  notificationSettings: {
    kinds: ["agent stopped", "agent asked", "monitor problem", "jira changed", "pr review", "stale prompt", "error"],
    mutedKinds: ["jira changed"],
    mutedTopics: ["mtg-wave-i", "mtg-wave-h"],
    staleAfterDays: 14,
    browserNotifications: "granted"
  },
  // Unattached T3 threads, for the "attach a T3 thread" picker.
  t3Unattached: [
    { id: "8b1e44c0", title: "Atlas: weather widget polish", env: "vic-desktop", status: "ready", updatedAt: "2026-11-25T08:58:00" },
    { id: "f3a2d901", title: "MTG Wave I orchestrator", env: "slopfactory", status: "running", updatedAt: "2026-11-25T09:38:00" },
    { id: "02c9be77", title: "Casa Clara: amend-to-fixed what-if", env: "vic-desktop", status: "stopped", updatedAt: "2026-11-23T19:40:00" }
  ],
  health: {
    server: { state: "ok", text: "Server up since 08:02 · backup 03:00" },
    claudeCode: { state: "ok", text: "Hooks installed · last event 4 min ago" },
    t3: { state: "ok", text: "T3 0.1.11-nightly.20261118.4890 · migration 98 · matches pin · read 3 s ago" }
  }
};
