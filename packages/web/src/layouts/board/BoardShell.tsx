import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Redirect } from "wouter";
import type { TopicListItem } from "../../api";
import { NotificationsList } from "../../components";
import type { ViewId } from "../../lib/domain";
import { healthRows } from "../../lib/health";
import { dateShort, hm } from "../../lib/time";
import { matchesQuery, viewsOf } from "../../lib/topics";
import { SettingsPage } from "../../pages/SettingsPage";
import { hrefs } from "../shared/routes";
import { ThemeToggle } from "../shared/ThemeToggle";
import { isTyping, useShell } from "../shared/useShell";
import { Lane, type Zone } from "./Lane";
import { Sheet } from "./Sheet";

const LANES: { view: ViewId; zone: Zone }[] = [
  { view: "attention", zone: "wide" },
  { view: "ongoing", zone: "wide" },
  { view: "monitoring", zone: "wide" },
  { view: "idle", zone: "pile" },
  { view: "blocked", zone: "pile" },
  { view: "stale", zone: "pile" },
  { view: "done", zone: "done" },
];

function byRecent(a: { lastWorkedAt: string }, b: { lastWorkedAt: string }): number {
  return a.lastWorkedAt < b.lastWorkedAt ? 1 : a.lastWorkedAt > b.lastWorkedAt ? -1 : 0;
}

/** The Board layout: one lane per view, a sheet for the open topic, a tray for notifications. */
export function BoardShell() {
  const {
    data,
    actions,
    route,
    navigate,
    now,
    list,
    selected,
    topics,
    notifications,
    titleOf,
    goTopic,
  } = useShell();
  const [query, setQuery] = useState("");
  const [tray, setTray] = useState(route.kind === "notifications");
  const filterRef = useRef<HTMLInputElement>(null);

  // Landing on /notifications (for instance after a layout switch) opens the tray.
  useEffect(() => {
    if (route.kind === "notifications") setTray(true);
  }, [route.kind]);

  const lanes = useMemo(() => {
    const out = new Map<ViewId, TopicListItem[]>(LANES.map((l) => [l.view, []]));
    for (const t of [...topics].sort(byRecent)) {
      if (!matchesQuery(t, query)) continue;
      for (const v of viewsOf(t)) out.get(v)?.push(t);
    }
    return out;
  }, [topics, query]);

  // /view/<view> brings that lane into sight.
  useEffect(() => {
    if (route.kind !== "view") return;
    document
      .querySelector(`.bd-lane[data-view="${route.view}"]`)
      ?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [route]);

  const closeTray = () => {
    setTray(false);
    if (route.kind === "notifications") navigate(hrefs.all);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "Escape" && tray) {
        closeTray();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (route.kind === "unknown") return <Redirect to={hrefs.all} replace />;

  const closeSheet = () => navigate(list === "all" ? hrefs.all : hrefs.view(list));
  const onSettings = route.kind === "settings";
  const iso = now.toISOString();

  return (
    <div
      className={`bd-app${data.error ? " has-banner" : ""}`}
      data-tray={tray ? "open" : "closed"}
    >
      <header className="bd-top">
        <div className="bd-brand">
          <span className="bd-brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          Axiom
        </div>
        <span className="bd-crumb">{onSettings ? "Settings" : "Status board"}</span>
        <div className="bd-nav">
          <Link href={hrefs.all} aria-current={!onSettings ? "page" : undefined}>
            Board
          </Link>
          <Link href={hrefs.settings} aria-current={onSettings ? "page" : undefined}>
            Settings
          </Link>
        </div>
        {onSettings ? null : (
          <label className="bd-filter">
            <span className="sr-only">Filter topics</span>
            <input
              ref={filterRef}
              type="search"
              placeholder="Filter topics"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>/</kbd>
          </label>
        )}
        <time className="bd-clock" dateTime={iso}>
          {dateShort(iso)} {hm(iso)}
        </time>
      </header>
      {data.error ? (
        <div className="banner bd-banner" role="alert">
          <span>{data.error.message}</span>
          <button type="button" className="btn ghost sm" onClick={data.clearError}>
            Dismiss
          </button>
        </div>
      ) : null}

      {onSettings ? (
        <div className="bd-page">
          <SettingsPage />
        </div>
      ) : (
        <main className="bd-board" aria-label="Topics by status">
          {data.topics ? (
            LANES.map(({ view, zone }) => (
              <LaneWithRule
                key={view}
                rule={view === "idle"}
                lane={
                  <Lane
                    view={view}
                    zone={zone}
                    topics={lanes.get(view) ?? []}
                    now={now}
                    focused={route.kind === "view" && route.view === view}
                    onOpen={goTopic}
                    onMarkStale={(slug) => void actions.markStale(slug)}
                    onDismissStale={(slug) => void actions.dismissStalePrompt(slug)}
                  />
                }
              />
            ))
          ) : (
            <p className="bd-empty">Loading.</p>
          )}
        </main>
      )}

      <footer className="bd-bar">
        <ul className="bd-health" aria-label="Provider health">
          {healthRows(data.health, now).map((r) => (
            <li key={r.name} className="bd-hl" data-state={r.state} title={r.text}>
              <i className="bd-hd" aria-hidden="true" />
              <b>{r.name}</b>
              <span className="bd-ht">{r.text}</span>
            </li>
          ))}
        </ul>
        <span className="bd-live" data-state={data.live ? "on" : "off"}>
          {data.live ? "live" : "offline"}
        </span>
        <button
          type="button"
          className="bd-bar-btn"
          aria-expanded={tray}
          aria-controls="bd-tray"
          onClick={() => (tray ? closeTray() : setTray(true))}
        >
          Notifications <span className="bd-count-b">{notifications.length}</span>
        </button>
        <ThemeToggle className="bd-bar-btn" />
      </footer>

      <section className="bd-tray" id="bd-tray" aria-label="Notifications">
        <header className="bd-tray-head">
          <h2>Notifications</h2>
          <span className="fine">
            {notifications.length} {notifications.length === 1 ? "notification" : "notifications"}
          </span>
          <button
            type="button"
            className="bd-x"
            aria-label="Close notifications"
            onClick={closeTray}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>
        </header>
        <div className="bd-tray-body">
          {tray ? (
            <NotificationsList
              notifications={notifications}
              titleOf={titleOf}
              hiddenCount={data.hiddenCount}
              now={now}
              onOpen={(slug) => {
                setTray(false);
                goTopic(slug);
              }}
            />
          ) : null}
        </div>
      </section>

      {selected && !onSettings ? (
        <Sheet
          slug={selected}
          listItem={topics.find((t) => t.slug === selected)}
          now={now}
          onClose={closeSheet}
        />
      ) : null}
    </div>
  );
}

function LaneWithRule({ rule, lane }: { rule: boolean; lane: React.ReactNode }) {
  return (
    <>
      {rule ? <div className="bd-rule" aria-hidden="true" /> : null}
      {lane}
    </>
  );
}
