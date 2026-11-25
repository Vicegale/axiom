# 09. Visual design

- Status: settled (2026-11-25)

## Intent

Settle how Axiom looks and is laid out before the first UI (build plan S5) is built. Mockups show only features the settled spec sections define; nothing invented.

What the first UI has to show (from 01, 04, 08):

- The tracker views: ongoing (`wip`), requires attention (`hitl`, `error`), under monitoring (`monitoring`, `review`), plus the `idle`, `blocked`, `stale` and `done` piles.
- A topic page: status and status note, goal, parent tickets and epics, threads with their own statuses and providers, links, monitoring targets, and the history timeline (one entry per kind).
- The notifications pane, with mute settings; topic highlights until clicked; the "mark as stale" prompt.
- A T3 thread picker for attaching threads to topics.

## References (from the owner, 2026-11-25)

### Relay (screenshot: [docs/design/references/relay.png](../design/references/relay.png))

An issue page for an agent-assisted tracker.

- **Look:** near-black canvas with a faint dot grid, IDE-like window, small dense type, a status bar along the bottom (version, sync state, watchers, encoding) and keyboard hints in a toolbar.
- **Layout:** three panes. Left: the issue's details (a compact key/value table for status, priority, assignee, team, dates; overview; tag chips; notes; linked reviews; related files). Centre: a graph canvas with the issue as the hub and its history as small cards radiating out on curved lines. Right: the thread conversation.
- **History cards:** a caps label naming who did what ("AGENT FOUND", "AGENT ASKED", "AGENT ADVISES", "AGENT DID", "YOU CHECKED", "IT CHECKED", "YOU APPROVED"), a relative time, two or three lines of text, and a border and line colour per kind (amber, orange, pink-red, green, teal). Older cards fade to grey.

### Are We Leonida Yet? (https://github.com/sevki/are-we-leonida-yet)

A live status dashboard for a busy repository (React 19, Vite, Tailwind 4, shadcn, Recharts, react-grid-layout, Geist font, neutral dark theme).

- **Layout:** a drag-and-resize grid of panels (layout editable, exportable, stored in the browser).
- **Content:** counts with trend charts, live activity feeds (opened / merged / closed, claims), problem lists ("claim problems", "competing PRs", "stale claims and review queue").
- **Liveness:** values flash green or red when they change, new rows glow and fade, a refresh bar counts down to the next poll.
- **Honest staleness:** a red "updates failing" badge with the reason, an amber "no update" badge, "quiet for N min".

### How they map onto Axiom (draft reading)

| Axiom part | Reference |
| --- | --- |
| Tracker home | Leonida: a live dashboard of panels: requires attention, ongoing, under monitoring, the idle / blocked / stale piles, a feed of history entries across topics, notifications. Liveness and staleness signals for the providers (T3 version mismatch, T3 unreadable, hooks silent). |
| Topic page | Relay: left pane is the topic's fields, parents, links and monitor targets; centre is the history as a graph; right pane is the topic's threads. |
| History graph | Topic as the hub; each thread a branch; its entries along the branch in time order; entries with no thread on their own branch. Card label = author + kind ("AGENT FOUND" = finding, "AGENT ASKED" = question / `hitl`, "IT CHECKED" = verification, "YOU APPROVED" = authorization, ...). |
| Right pane | Threads with provider and status only. Relay's conversation, reply box and suggestions are multi-task UI features (02) that are not specified yet, so they stay out of the first build. |

## Mockups (2026-11-25)

Four structurally distinct mockups in [docs/design/mockups/](../design/mockups/) (`src/` + `build.py`; screenshots in `screens/`): 1 Inbox, 2 Board, 3 Console, 4 Mission control. Same data, same tokens; only the structure differs.

The owner likes 1, 2 and 3 and asked whether all three can ship as layout options chosen on a settings page.

### Can the three layouts coexist? (analysis, draft)

They share all data and every action; they differ only in where things sit. What has to be shared so they don't drift:

| Piece | Inbox | Board | Console | Shared |
| --- | --- | --- | --- | --- |
| Topic detail | right reading pane | sheet over the board | bottom panel with tabs | one topic-detail component, rendered in three containers |
| History | list grouped by day | tab in the sheet | log lines with kind chips | one history component with a dense and a roomy density |
| Notifications | replaces the middle list | tray from the status bar | right drawer | one notifications list; the settings move to the settings page |
| Navigation | mailboxes (views + piles) | columns | tree + saved views | the same view and pile definitions from `core` |
| Selection | selected topic | open sheet | selected row | one URL, `/topic/<slug>`, so switching layout keeps the open topic |
| Keyboard | arrows | none | j / k / enter | one shortcut set for all three |
| Hierarchy | parent chips | parent chips | tree | the console tree only; others show chips |

Where they would collide:

- **Future features cost three times the layout work.** Every new feature has to find a place in three shells. Mitigation: features go into shared components; a shell only decides placement.
- **The multi-task view** is not a fourth layout: it is a separate vertical of the application (owner, 2026-11-25), so it does not affect the tracker layouts.
- **Testing** triples for layout-level checks (not for logic, which lives in `core` and shared components).


## Decisions

- 2026-11-25: The tracker ships three layouts, Inbox (1), Board (2) and Console (3), built on shared components as in the table above. Mission control (4) is dropped.
- 2026-11-25: Inbox is the default.
- 2026-11-25: The layout is chosen only on the settings page; no quick switcher. If the owner keeps needing something from another layout, it gets designed into the layout they use.
- 2026-11-25: The settings page holds the layout, light/dark, and the notification settings (muted kinds, muted topics, stale threshold, browser permission). The notifications pane is just the list.
- 2026-11-25: Ship one layout first (Inbox), then Board and Console, so the shared pieces settle before three layouts depend on them.
- 2026-11-25: Expected outcome: the owner settles into one layout and pulls ideas from the others into it; the three may converge into one experience over time.
- 2026-11-25: The multi-task view is a separate vertical of the application, not a tracker layout (see 02).
- 2026-11-25: No dotted-grid background in the tracker. It is reserved for when Axiom shows graphs.
- 2026-11-25: The first graph is the task dependency graph, in its own section of the topic page (all three layouts), drawn on the dotted grid. Nodes are tasks coloured by status, laid out left to right in dependency order; an arrow runs from a prerequisite to the task that waits on it.
- 2026-11-25: The settings page has a Notifications section: one toggle per notification kind, all on by default (turning one off mutes that kind), plus muted topics and browser notifications. The stale threshold has its own section.

## Document viewer (2026-11-25)

Clicking a `spec` link (or an `artifact` link to a `.md` file) opens the file rendered in the app (owner request).

- **Rendering:** GitHub-flavoured Markdown (tables, task lists, footnotes, autolinks), syntax-highlighted code, heading anchors, and Mermaid diagrams (` ```mermaid ` blocks) themed to match light/dark. Raw HTML in the file is sanitised.
- **Navigation:** a table of contents from the headings; relative links to other Markdown files in the same repository open in the viewer; relative images display; external links open in a new tab.
- **Where:** it replaces the topic detail in each layout (Inbox reader, Board sheet, Console panel) with a back control and a "wide" toggle that hides the list/sidebars; the route is `/topic/<slug>/doc/<linkId>[?path=<relative>]`, so it is linkable and Back works.
- **Freshness:** the viewer re-reads the file when it changes on disk.
- **Which files the server will read:** only files inside a directory the topic links to (`repository` or `worktree` links), plus the exact files its `spec`/`artifact` links name; Markdown and common image types only; size-capped; no path traversal. The server stays loopback-only.

## Web standards baseline (2026-11-25)

The owner asked that the UI follow modern web standards (for example, resizable sidebars). Every layout meets this baseline:

1. **Resizable panes.** Every sidebar and split is resizable by dragging a separator: Inbox rail and list columns; Console sidebar, notifications drawer and the bottom panel's height; Board topic sheet width and notifications tray height. Separators are real `role="separator"` elements with `aria-orientation`, `aria-valuenow/min/max`, keyboard resizing (arrow keys, Home/End), double-click to reset, and sensible minimums and maximums. Sizes persist per browser (localStorage, guarded with try/catch) and never cause horizontal page scroll.
2. **Collapsible.** The Inbox rail and the Console sidebar can collapse to icons/zero and back (button plus keyboard shortcut), remembered per browser.
3. **Responsive.** Usable down to 1024 px wide without overlap; below ~900 px the layouts fall back to one main column with the other panes as overlays. Use container queries where a component depends on its pane's width, not the viewport.
4. **Links are links.** Anything that navigates (topics, views, notifications, settings) is an `<a href>` so middle-click and "open in new tab" work; buttons only perform actions. Back and forward restore the open topic, view and open sheet or drawer (the sheet/drawer state is in the URL).
5. **Keyboard and focus.** Visible focus (`:focus-visible`) everywhere; a "skip to content" link; Escape closes sheets, drawers, menus and pickers and returns focus to what opened them; modal surfaces trap focus (native `<dialog>` or `inert` on the background); menus and pickers use the native popover API or `<dialog>` where it fits.
6. **Semantics and ARIA.** Landmarks (`header`, `nav`, `main`, `aside`, `footer`), one `h1` per page and ordered headings, `aria-current` on the active nav item, lists as lists, tables as tables with header cells and `aria-sort` on sortable columns.
7. **Live updates are announced politely.** Changes arriving over SSE (new notifications, a topic needing attention) go to an `aria-live="polite"` region; nothing steals focus.
8. **Document title** reflects the route and the count of things needing the owner, e.g. `(2) Axiom: spec phase · Axiom`.
9. **User preferences.** `prefers-color-scheme` (with the theme setting), `prefers-reduced-motion` (no slide or glow animations), `forced-colors` (borders and focus still visible), and `color-scheme` set so native controls and scrollbars match the theme.
10. **Scaling.** Sizes in `rem`, so browser zoom and font-size settings work; usable at 200% zoom.
11. **Contrast.** WCAG 2.2 AA for text and meaningful non-text (status dots, focus rings) in both themes.
12. **Scroll.** Each pane scrolls on its own and keeps its position when data refreshes; `scrollbar-gutter: stable` so refreshes don't shift layout.

## Open questions

1. References: which apps does it feel closest to (T3 Code itself, Linear, GitHub Projects, a terminal dashboard, something else)? Anything to avoid?
2. Should it match T3 Code visually, since the multi-task UI will live next to it, or have its own identity?
3. Light, dark, or both?
4. Density: compact (many topics on screen, like a list or table) or roomy (cards)?
5. Main layout of the tracker: columns per view (a board), one list grouped by view, or an inbox (requires attention first, everything else below)?
6. How strongly do statuses carry colour? Is each status its own colour, or is colour kept for "needs you" (`hitl`, `error`, highlights) only?
7. Where does the notifications pane live: a sidebar, a drawer, or a page?
8. Desktop only for now, or should the tracker already work at phone width?
