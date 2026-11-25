import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Redirect } from "wouter";
import { api } from "../../api";
import { NotificationsList } from "../../components";
import { useResource } from "../../data/useResource";
import { VIEW_IDS, VIEW_LABEL, type ViewId } from "../../lib/domain";
import { healthRows } from "../../lib/health";
import { inView, matchesQuery, type SortKey, sortTopics, viewsOf } from "../../lib/topics";
import { buildTree } from "../../lib/tree";
import { SettingsPage } from "../../pages/SettingsPage";
import { hrefs } from "../shared/routes";
import { ThemeToggle } from "../shared/ThemeToggle";
import { isTyping, useShell } from "../shared/useShell";
import { Glyph } from "./Glyph";
import { Panel } from "./Panel";
import { type Group, TopicTable } from "./TopicTable";
import { Tree } from "./Tree";

const ASC_FIRST: Record<SortKey, 1 | -1> = { status: 1, slug: 1, title: 1, last: -1 };
const VIEW_GLYPH_STATUS = {
  attention: "hitl",
  ongoing: "wip",
  monitoring: "monitoring",
  idle: "idle",
  blocked: "blocked",
  stale: "stale",
  done: "done",
} as const;

/** The Console layout: a tree and saved views on the left, a dense table, the selected topic in a
 *  bottom panel, notifications in a right drawer. */
export function ConsoleShell() {
  const {
    data,
    route,
    navigate,
    now,
    list,
    selected,
    topics,
    notifications,
    titleOf,
    goTopic,
    openTopic,
    goList,
  } = useShell();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "last", dir: -1 });
  const [drawer, setDrawer] = useState(route.kind === "notifications");
  const [cursor, setCursor] = useState(-1);
  const filterRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (route.kind === "notifications") setDrawer(true);
  }, [route.kind]);

  const tree = useResource(
    "console-tree",
    () => Promise.all([api.epics().catch(() => []), api.tickets().catch(() => [])]),
    data.tick,
  );
  const nodes = useMemo(
    () => buildTree(tree.data?.[0] ?? [], tree.data?.[1] ?? [], topics),
    [tree.data, topics],
  );

  const groups: Group[] = useMemo(() => {
    const views: readonly ViewId[] = list === "all" ? VIEW_IDS : [list];
    const matching = topics.filter((t) => matchesQuery(t, query));
    return views.map((view) => ({
      view,
      topics: sortTopics(
        matching.filter((t) => (list === "all" ? viewsOf(t).includes(view) : inView(t, view))),
        sort.key,
        sort.dir,
      ),
    }));
  }, [topics, list, query, sort]);
  const rows = useMemo(() => groups.flatMap((g) => g.topics.map((t) => t.slug)), [groups]);
  const shown = new Set(rows).size;

  const closeDrawer = () => {
    setDrawer(false);
    if (route.kind === "notifications") navigate(hrefs.all);
  };

  // j / k walk the rows, / filters, n toggles notifications, t flips the theme.
  const move = (dir: 1 | -1) => {
    if (!rows.length) return;
    const at = rows[cursor] === selected ? cursor : rows.indexOf(selected ?? "");
    const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + dir));
    setCursor(next);
    const slug = rows[next];
    if (slug) goTopic(slug);
    const tr = tableRef.current?.querySelectorAll<HTMLElement>("tr.cs-row")[next];
    tr?.focus();
    tr?.scrollIntoView?.({ block: "nearest" });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isTyping(e)) (e.target as HTMLElement).blur();
        else if (drawer) closeDrawer();
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (route.kind === "settings") return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        move(e.key === "j" ? 1 : -1);
      } else if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "n") {
        if (drawer) closeDrawer();
        else setDrawer(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (route.kind === "unknown") return <Redirect to={hrefs.all} replace />;

  const onSettings = route.kind === "settings";
  const count = (v: ViewId) => topics.filter((t) => inView(t, v)).length;
  const counts = {
    attention: count("attention"),
    ongoing: count("ongoing"),
    unread: topics.filter((t) => t.highlighted).length,
  };
  const sortLabel = `${sort.key} ${sort.dir > 0 ? "↑" : "↓"}`;

  return (
    <div className={`cs-app${drawer ? " drawer-open" : ""}`}>
      <aside className="cs-side" aria-label="Hierarchy and views">
        <div className="cs-brand">
          Axiom <small>console</small>
        </div>
        <nav className="cs-tree" aria-label="Hierarchy">
          <Tree nodes={nodes} selected={selected} onOpen={openTopic} />
        </nav>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the list */}
        <div className="cs-views" role="group" aria-label="Views and piles">
          <h2>Saved views</h2>
          <Link
            href={hrefs.all}
            className="cs-view"
            aria-current={
              !onSettings && list === "all" && route.kind !== "view" ? "true" : undefined
            }
          >
            <span className="cs-glyph" aria-hidden="true">
              ≡
            </span>
            {VIEW_LABEL.all}
            <span className="n">{topics.length}</span>
          </Link>
          {VIEW_IDS.map((v) => (
            <Link
              key={v}
              href={hrefs.view(v)}
              className="cs-view"
              aria-current={route.kind === "view" && route.view === v ? "true" : undefined}
            >
              <Glyph status={VIEW_GLYPH_STATUS[v]} />
              {VIEW_LABEL[v]}
              <span className={`n${v === "attention" && count(v) ? " hot" : ""}`}>{count(v)}</span>
            </Link>
          ))}
          <Link
            href={hrefs.settings}
            className="cs-view cs-settings-link"
            aria-current={onSettings ? "true" : undefined}
          >
            <span className="cs-glyph" aria-hidden="true">
              ⚙
            </span>
            Settings
          </Link>
        </div>
      </aside>

      <main className="cs-main">
        {onSettings ? (
          <div className="cs-page">
            <SettingsPage />
          </div>
        ) : (
          <>
            <div className="cs-bar">
              <span className="cs-ctx">
                Topics <b>{shown}</b> of {topics.length} · sorted by {sortLabel}
              </span>
              <label className="sr-only" htmlFor="cs-filter">
                Filter visible rows
              </label>
              <input
                id="cs-filter"
                ref={filterRef}
                className="cs-filter"
                type="search"
                placeholder="filter rows  /"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {list !== "all" ? (
                <span className="cs-chipx">
                  view: {VIEW_LABEL[list]}
                  <button
                    type="button"
                    aria-label="Clear view filter"
                    onClick={() => goList("all")}
                  >
                    ×
                  </button>
                </span>
              ) : null}
              <div className="cs-keys">
                <span>
                  <kbd>j</kbd>
                  <kbd>k</kbd> move
                </span>
                <span>
                  <kbd>enter</kbd> open
                </span>
                <span>
                  <kbd>/</kbd> filter
                </span>
                <span>
                  <kbd>n</kbd> notifications
                </span>
              </div>
            </div>
            <div className="cs-tablewrap" ref={tableRef}>
              {data.topics ? (
                <TopicTable
                  groups={groups}
                  selected={selected}
                  sort={sort.key}
                  dir={sort.dir}
                  now={now}
                  onSort={(key) =>
                    setSort((s) =>
                      s.key === key
                        ? { key, dir: s.dir === 1 ? -1 : 1 }
                        : { key, dir: ASC_FIRST[key] },
                    )
                  }
                  onOpen={openTopic}
                  onGo={goTopic}
                />
              ) : (
                <p className="cs-empty">Loading.</p>
              )}
            </div>
            <div className="cs-split" aria-hidden="true">
              <i />
            </div>
            <Panel slug={selected} listItem={topics.find((t) => t.slug === selected)} now={now} />
          </>
        )}
      </main>

      {drawer ? (
        <aside className="cs-drawer" aria-label="Notifications">
          <header>
            <b>Notifications</b>
            <span className="cs-count">{notifications.length}</span>
            <button type="button" className="btn ghost sm cs-sp" onClick={closeDrawer}>
              Close
            </button>
          </header>
          <div className="cs-dbody">
            <NotificationsList
              notifications={notifications}
              titleOf={titleOf}
              hiddenCount={data.hiddenCount}
              now={now}
              onOpen={goTopic}
            />
          </div>
        </aside>
      ) : null}

      <footer className="cs-status">
        <div className="cs-health">
          {healthRows(data.health, now).map((r) => (
            <span key={r.name} className="cs-hl" data-state={r.state} title={r.text}>
              <i className="cs-hdot" aria-hidden="true" />
              {r.name}
            </span>
          ))}
        </div>
        <span className="cs-counts">
          {topics.length} topics · {counts.attention} need you · {counts.ongoing} ongoing ·{" "}
          {counts.unread} unread
        </span>
        <span className="cs-live" data-state={data.live ? "on" : "off"}>
          {data.live ? "live" : "offline"}
        </span>
        <div className="cs-sp cs-tg-row">
          <button
            type="button"
            className="cs-tg"
            aria-pressed={drawer}
            onClick={() => (drawer ? closeDrawer() : setDrawer(true))}
          >
            Notifications
            {notifications.length ? <span className="badge">{notifications.length}</span> : null}
          </button>
          <ThemeToggle className="cs-tg" />
        </div>
      </footer>
    </div>
  );
}
