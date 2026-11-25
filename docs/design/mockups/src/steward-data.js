/* Sample data and shared renderers for the Steward view mockups (spec 03). Everything shown is a decided feature of 03. */
const STEWARD = {
  on: true,
  nextWake: "14:30",
  workingHours: "09:00–19:00",
  lastWake: {
    at: "14:00", took: "1 m 48 s", trigger: "timer", tokens: "133k",
    stages: [
      { n: 1, name: "Gather", model: "Haiku 5.5", effort: "low", tokens: "48k",
        did: "9 topics, 6 PRs, 14 unseen Slack messages" },
      { n: 2, name: "Decide", model: "Sonnet 5.5", effort: "low", tokens: "21k",
        did: "5 findings, 4 questions, 1 promotion" },
      { n: 3, name: "Promoted", model: "Sonnet 5.5", effort: "medium", tokens: "64k",
        did: "simple: Wave I snapshot fix" },
    ],
    blindSpots: ["Google Drive isn't connected on this machine"],
  },
  wakes: [
    { at: "14:00", trigger: "timer", summary: "5 findings · 4 questions · 1 promoted", tokens: "133k" },
    { at: "13:41", trigger: "review on mtg#219", summary: "1 suggestion", tokens: "22k" },
    { at: "13:30", trigger: "timer", summary: "nothing new", tokens: "31k" },
    { at: "13:00", trigger: "timer", summary: "2 findings · 1 question", tokens: "52k" },
    { at: "09:05", trigger: "tidy-up", summary: "memory: merged 3, retired 2, core rewritten", tokens: "18k" },
  ],
  questions: [
    { id: "q1", topic: "mtg-wave-i", topicTitle: "MTG Wave I", kind: "judgement",
      text: "This morning's standup says rows 59–67 slip to next week. Should Wave I's goal say so?",
      source: "Slack #mtg-standup", at: "14:00" },
    { id: "q2", topic: null, kind: "blind spot",
      text: "I can't read Google Drive here, so I'm missing the meeting transcripts. Skip them on this machine?",
      source: "unreachable source", at: "14:00" },
    { id: "q3", topic: null, kind: "blind spot",
      text: "PR atlas#41 (\"Coolify: health check path\") has no topic. Is it part of Atlas Coolify deployment?",
      source: "PR without a topic", at: "14:00" },
    { id: "q4", topic: "ahoy-usability", topicTitle: "Usability pass", kind: "judgement",
      text: "Its PR merged 3 days ago and nothing has happened since. Is it done?",
      source: "tidy-up", at: "13:00" },
  ],
  findings: [
    { id: "f1", level: "urgent", topic: "mtg-wave-i", topicTitle: "MTG Wave I", at: "14:00", notified: true,
      title: "CI failed on mtg#214",
      text: "The deck-gaps snapshot has no row for the Ninjutsu card added in 3f2c1a0.",
      fix: "s1" },
    { id: "f2", level: "attention", topic: "mtg-wave-i", topicTitle: "MTG Wave I", at: "14:00",
      title: "Conflict coming on mtg#219",
      text: "main changed src/rules/ward.ts, which this PR also touches.",
      did: { what: "Rebased row-60-ward onto main locally (clean). Pushing is yours.",
             details: "a91c0de → e47b2f9 · old tip saved at refs/axiom/backup/row-60-ward/20261125-1400" } },
    { id: "f3", level: "attention", topic: "atlas-coolify-deployment", topicTitle: "Atlas Coolify deployment", at: "14:00",
      title: "No reviewer on atlas#38 for 4 days",
      text: "Sam usually reviews atlas and is out until Monday." },
    { id: "f4", level: "info", topic: "mtg-wave-i", topicTitle: "MTG Wave I", at: "14:00",
      title: "mtg#212 is ready to merge", text: "Approved, CI green." },
    { id: "f5", level: "info", topic: "axiom-mockups", topicTitle: "Axiom: UI mockups", at: "14:00",
      title: "Moved Axiom: UI mockups to done", text: "Its PR merged at 14:02.",
      changed: { from: "review", to: "done" } },
  ],
  suggestions: [
    { id: "s1", branch: "axiom/fix/mtg-214-snapshot", topic: "mtg-wave-i", topicTitle: "MTG Wave I",
      title: "Update the deck-gaps snapshot for the Ninjutsu row",
      meta: "for mtg#214 · +3 −1 · tests pass · Sonnet 5.5 medium", at: "14:03",
      patch: [
        ["ctx", "  Row 60  Ward          3 gaps"],
        ["del", "  Row 61  Ninjutsu      2 gaps"],
        ["add", "  Row 61  Ninjutsu      3 gaps"],
        ["add", "    + Ingenious Infiltrator (MKC 121)"],
        ["add", "    + Prosperous Thief (MKC 140)"],
        ["ctx", "  Row 63  Mutate        5 gaps"],
      ] },
    { id: "s2", branch: "axiom/rebase/row-61-ninjutsu", topic: "mtg-wave-i", topicTitle: "MTG Wave I",
      title: "row-61-ninjutsu rebased onto main, as a copy",
      meta: "someone else pushed to the branch, so not in place · 4 commits", at: "13:41",
      patch: [
        ["ctx", "  4 commits replayed onto main @ 7d1e0b2"],
        ["ctx", "  no conflicts"],
      ] },
  ],
  memory: {
    core: {
      used: 1140, budget: 2000, rewritten: "09:05",
      facts: [
        "The owner prefers a false alarm to a miss: when unsure, say it.",
        "Lint-only CI failures: dismissed 4 of 4. Report quietly, don't promote.",
        "Standups are at 10:00; notes go to Slack #mtg-standup.",
        "A failed atlas health check after a deploy is urgent.",
      ],
      index: [["atlas deploy steps", 3], ["who reviews which repo", 5], ["ahoy release calendar", 2], ["working hours", 1]],
    },
    attached: [
      { to: "topic", name: "mtg-wave-i", items: ["Rows 59–67 slipped to next week (standup, 25 Nov).", "Snapshots: tests/__snapshots__, update with npm run snap."] },
      { to: "repo", name: "atlas", items: ["Merges main into branches; never rebase its branches.", "Health check path is /healthz since atlas#33."] },
      { to: "person", name: "Sam", items: ["Reviews atlas PRs.", "Out until Monday 1 Dec."] },
    ],
    general: [
      "gh is logged in as the owner; rate limit has never been close.",
      "T3 threads report subagents in orchestration_v2_projection_subagents.",
    ],
  },
  usage: [
    { model: "Haiku 5.5", used: 1.21, cap: 5 },
    { model: "Sonnet 5.5", used: 0.31, cap: 1.5 },
    { model: "Opus 5.5", used: 0, cap: 0.4 },
  ],
  settings: {
    stages: [["Gather and summarise", "Haiku 5.5", "low"], ["Decide", "Sonnet 5.5", "low"]],
    complexity: [["simple", "Sonnet 5.5", "medium"], ["medium", "Opus 5.5", "high"], ["hard", "report only", ""]],
    signals: ["CI failed", "changes requested", "new review comments", "conflict coming", "no reviewer after 3 days", "ready to merge"],
    sources: [["GitHub (gh)", "ok"], ["Slack", "ok"], ["Google Drive", "not connected"]],
  },
  chat: [
    { who: "owner", text: "Why did you rebase row-60-ward?" },
    { who: "steward", text: "main changed src/rules/ward.ts and mtg#219 touches the same file, so a conflict was coming while the PR is in review. The rebase was clean and nobody else had pushed, so I did it in place and saved the old tip. I didn't push." },
    { who: "owner", text: "Ok. Don't rebase atlas branches, that repo merges main instead." },
    { who: "steward", text: "Understood: for atlas I'll only report.", noted: "atlas merges main; never rebase its branches → repo atlas" },
    { who: "owner", text: "Check atlas-coolify-deployment now." },
    { who: "steward", text: "Checking it now.", acting: true },
  ],
};
const SUG = Object.fromEntries(STEWARD.suggestions.map((s) => [s.id, s]));
const ATTACHED_FIXES = new Set(STEWARD.findings.filter((f) => f.fix).map((f) => f.fix));

/* ---------- shared renderers ---------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ICON = {
  steward: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/><path d="M8 1.5v13L1.5 8z" fill="currentColor"/></svg>`,
  stewardOff: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/><path d="M8 1.5v13L1.5 8z" fill="currentColor" opacity=".45"/><path d="M2 14 14 2" stroke-linecap="round"/></svg>`,
  x: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
  gear: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/><circle cx="5" cy="4" r="1.6" fill="var(--bg)"/><circle cx="10.5" cy="8" r="1.6" fill="var(--bg)"/><circle cx="7" cy="12" r="1.6" fill="var(--bg)"/></svg>`,
  chat: `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>`,
  send: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>`,
  theme: `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/></svg>`,
  off: `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/><path d="M2.5 13.5l11-11"/></svg>`,
  diamond: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/></svg>`,
};
const R = {
  topic(slug, title) { return slug ? `<a class="tlink" href="#topic/${slug}">${esc(title || slug)}</a>` : ""; },
  metaLine(parts) { return `<p class="meta-line">${parts.filter(Boolean).join('<span class="sep">·</span>')}</p>`; },
  dismiss(label = "Dismiss") { return `<button class="icon-btn reveal" aria-label="${label}" title="${label}">${ICON.x}</button>`; },

  /* question: text first; Answer opens a field on demand */
  question(q, o = {}) {
    return `<article class="item q">
      <div class="item-main">
        <p class="item-text">${esc(q.text)}</p>
        ${R.metaLine([`<span class="kind kind-${q.kind.replace(" ", "-")}">${q.kind}</span>`, R.topic(q.topic, q.topicTitle), esc(q.source), o.noTime ? "" : q.at])}
        <form class="answer" hidden onsubmit="return false"><input aria-label="Your answer" placeholder="Your answer"><button class="btn btn-primary btn-sm" type="submit">Send</button><button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancel</button></form>
      </div>
      <div class="item-acts"><button class="btn btn-sm" data-answer>Answer</button>${R.dismiss()}</div>
    </article>`;
  },

  fix(s, open) {
    return `<div class="fix">
      <div class="fix-h"><code class="br">${s.branch}</code><span class="meta">${esc(s.meta)}</span></div>
      ${R.diff(s, open)}
      <div class="fix-acts"><button class="btn btn-primary btn-sm" title="Applies it to your branch locally. Pushing stays yours.">Adopt</button><button class="btn btn-sm" data-diff aria-expanded="${!!open}">Diff</button><button class="btn btn-ghost btn-sm">Discard</button></div>
    </div>`;
  },
  diff(s, open) { return `<pre class="diff" ${open ? "" : "hidden"}>${s.patch.map(([k, l]) => `<span class="d-${k}">${esc(l)}</span>`).join("\n")}</pre>`; },

  /* finding: title + cause; a prepared fix, an action Steward took, or a status change sit inside it */
  finding(f, o = {}) {
    let inner = "";
    if (f.fix) inner = R.fix(SUG[f.fix], o.diffOpen);
    if (f.did) inner = `<div class="did"><span>${esc(f.did.what)}</span><button class="btn btn-ghost btn-sm">Undo</button><details><summary>Details</summary><code>${esc(f.did.details)}</code></details></div>`;
    if (f.changed) inner = `<div class="did"><span class="pill s-${f.changed.from}">${f.changed.from}</span>→<span class="pill s-${f.changed.to}">${f.changed.to}</span><span class="meta">by Steward</span><button class="btn btn-ghost btn-sm">Undo</button></div>`;
    const lvl = f.level === "urgent" ? `<span class="lvl">Urgent</span>` : "";
    return `<article class="item f lv-${f.level}">
      <div class="item-main">
        <p class="item-title">${lvl}${esc(f.title)}</p>
        <p class="item-text dim">${esc(f.text)}</p>
        ${inner}
        ${R.metaLine([R.topic(f.topic, f.topicTitle), o.noTime ? "" : f.at, f.notified ? "desktop notified" : ""])}
      </div>
      <div class="item-acts">${R.dismiss()}</div>
    </article>`;
  },

  suggestion(s, o = {}) {
    return `<article class="item sg">
      <div class="item-main">
        <p class="item-title">${esc(s.title)}</p>
        ${R.metaLine([`<code class="br">${s.branch}</code>`, esc(s.meta), R.topic(s.topic, s.topicTitle), o.noTime ? "" : s.at])}
        ${R.diff(s, o.diffOpen)}
        <div class="fix-acts"><button class="btn btn-primary btn-sm" title="Applies it to your branch locally. Pushing stays yours.">Adopt</button><button class="btn btn-sm" data-diff aria-expanded="${!!o.diffOpen}">Diff</button></div>
      </div>
      <div class="item-acts"><button class="icon-btn reveal" aria-label="Discard" title="Discard">${ICON.x}</button></div>
    </article>`;
  },

  coreMeter(c) {
    const pct = Math.round((c.used / c.budget) * 100);
    return `<div class="core-meter" title="Loaded into every wake and chat"><div class="meter"><span style="width:${pct}%"></span></div><span class="meta">${(c.used / 1000).toFixed(1)}k / ${c.budget / 1000}k</span></div>`;
  },
  memList(items) { return `<ul class="mem-list">${items.map((t) => `<li class="mem"><span>${esc(t)}</span><button class="icon-btn reveal btn-edit" aria-label="Edit">Edit</button></li>`).join("")}</ul>`; },
  memIndex(c) { return `<div class="index"><span class="meta">Also knows about</span>${c.index.map(([n, k]) => `<a href="#mem/${n}">${n} <span class="meta">${k}</span></a>`).join("")}</div>`; },
  attached(groups) { return groups.map((g) => `<div class="mem-group"><p class="mem-group-h"><span class="mem-to">${g.to}</span>${g.name}</p>${R.memList(g.items)}</div>`).join(""); },

  usage(list) {
    return `<div class="usage">${list.map((u) => {
      const pct = u.cap ? Math.max(1, Math.round((u.used / u.cap) * 100)) : 0;
      return `<span>${u.model}</span><div class="meter"><span style="width:${pct}%"></span></div><span class="meta num">${u.used}M / ${u.cap}M</span>`;
    }).join("")}</div>`;
  },

  chatMsg(m) {
    const noted = m.noted ? `<p class="noted"><span class="noted-l">Noted</span>${esc(m.noted)}</p>` : "";
    const acting = m.acting ? `<p class="acting"><span class="dot s-wip"></span>running</p>` : "";
    return `<div class="msg msg-${m.who}"><div class="msg-b">${esc(m.text)}</div>${noted}${acting}</div>`;
  },
  composer() {
    return `<form class="composer" onsubmit="return false"><textarea rows="1" aria-label="Message Steward" placeholder="Ask Steward or tell it to do something"></textarea><button class="model" type="button" title="Model for this chat">Sonnet 5.5 · medium</button><button class="icon-btn send" type="submit" aria-label="Send">${ICON.send}</button></form>`;
  },

  needsCount() { return STEWARD.questions.length + STEWARD.findings.filter((f) => f.level !== "info").length + STEWARD.suggestions.filter((s) => !ATTACHED_FIXES.has(s.id)).length; },
  topBar({ page = "steward", chat = false, settings = true } = {}) {
    const n = R.needsCount();
    return `<a class="brand" href="#">${ICON.diamond}<span>${page === "desk" ? "Desk" : "Steward"}</span></a>
      <nav class="page-switch" aria-label="Pages"><a href="#">Tracker</a><a href="#" ${page === "desk" ? 'aria-current="page"' : ""}>Desk</a><a href="#" ${page === "steward" ? 'aria-current="page"' : ""}><span class="st-ic">${ICON.steward}</span>Steward<span class="count" aria-label="${n} need you">${n}</span></a></nav>
      <span class="grow"></span>
      <button class="st-toggle on" aria-pressed="true" title="Last wake ${STEWARD.lastWake.at} · off stops new wakes; a running wake finishes"><span class="sw"></span><span class="st-ic">${ICON.steward}</span>Steward<span class="meta">next ${STEWARD.nextWake}</span></button>
      ${chat ? `<button class="icon-btn bar-btn" data-chat aria-label="Chat with Steward" title="Chat with Steward (c)">${ICON.chat}<span>Chat</span></button>` : ""}
      ${settings ? `<a class="icon-btn" href="#settings" aria-label="Steward settings" title="Steward settings">${ICON.gear}</a>` : ""}
      <button class="icon-btn" aria-label="Toggle theme" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'">${ICON.theme}</button>`;
  },
};

/* ---------- shared behaviour ---------- */
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-answer]");
  if (a) { const it = a.closest(".item"); it.querySelector(".answer").hidden = false; a.hidden = true; it.querySelector(".answer input").focus(); return; }
  const c = e.target.closest("[data-cancel]");
  if (c) { const it = c.closest(".item"); it.querySelector(".answer").hidden = true; it.querySelector("[data-answer]").hidden = false; return; }
  const d = e.target.closest("[data-diff]");
  if (d) { const host = d.closest(".fix") || d.closest(".item"); const pre = host.querySelector(".diff"); pre.hidden = !pre.hidden; d.setAttribute("aria-expanded", String(!pre.hidden)); }
});
document.addEventListener("input", (e) => { if (e.target.matches(".composer textarea")) { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; } });
