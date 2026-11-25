import { useEffect, useMemo, useState } from "react";
import { Redirect, useLocation } from "wouter";
import { NotificationsList, SkipLink, Splitter } from "../../components";
import { VIEW_LABEL } from "../../lib/domain";
import { isNarrow, useCollapsed, usePaneSize } from "../../lib/panes";
import { effectiveTheme } from "../../lib/theme";
import { useWide } from "../../lib/wide";
import { SettingsPage } from "../../pages/SettingsPage";
import { hrefs } from "../shared/routes";
import { isTyping, useShell } from "../shared/useShell";
import { type Active, Rail } from "./Rail";
import { Reader } from "./Reader";
import { StatusBar } from "./StatusBar";
import { TopicList, visibleTopics } from "./TopicList";

/** The Inbox layout: rail, middle list, right reading pane. */
export function InboxShell() {
  const {
    data,
    actions,
    route,
    now,
    list,
    selected,
    topics,
    notifications,
    titleOf,
    openTopic,
    goTopic,
  } = useShell();
  const [query, setQuery] = useState("");
  const [wideDoc, setWide] = useWide();
  const [location] = useLocation();
  const [railClosed, toggleRail, setRailClosed] = useCollapsed("inbox-rail");
  const rail = usePaneSize("inbox-rail", { default: 232, min: 168, max: 380 });
  const listPane = usePaneSize("inbox-list", {
    default: 400,
    min: 280,
    max: () => Math.max(280, window.innerWidth - (railClosed ? 0 : rail.size) - 420),
  });

  // On a narrow window the rail is an overlay: following a link closes it (not remembered).
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes when the location changes.
  useEffect(() => {
    if (isNarrow()) setRailClosed(true, false);
  }, [location, setRailClosed]);

  // Arrow keys walk the visible list (outside text fields).
  const ordered = useMemo(() => visibleTopics(topics, list, query), [topics, list, query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "[" && !isTyping(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggleRail();
        return;
      }
      if (e.key === "Escape" && isNarrow() && !railClosed) {
        setRailClosed(true, false);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (route.kind === "settings" || route.kind === "notifications") return;
      // In a document the arrow keys scroll it.
      if (route.kind === "doc" || isTyping(e)) return;
      if (!ordered.length) return;
      e.preventDefault();
      const i = ordered.findIndex((t) => t.slug === selected);
      const next = e.key === "ArrowDown" ? Math.min(i + 1, ordered.length - 1) : Math.max(i - 1, 0);
      const target = ordered[i === -1 ? 0 : next];
      if (target && target.slug !== selected) goTopic(target.slug);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selected, route.kind, goTopic, toggleRail, railClosed, setRailClosed]);

  if (route.kind === "unknown") return <Redirect to={hrefs.all} replace />;

  const active: Active =
    route.kind === "notifications"
      ? "notifications"
      : route.kind === "settings"
        ? "settings"
        : list;
  const onNotifs = route.kind === "notifications";
  const wide = route.kind === "doc" && wideDoc;
  const onSettings = route.kind === "settings";
  const items = onNotifs ? notifications.length : visibleTopics(topics, list, query).length;

  return (
    <div
      className={`app${data.error ? " has-banner" : ""}`}
      data-rail={railClosed ? "closed" : "open"}
      data-topic={selected ? "open" : undefined}
      data-wide={wide ? "true" : undefined}
    >
      <SkipLink />
      <header className="bar">
        <div className="bar-start">
          <button
            type="button"
            className="icon-btn"
            aria-label={railClosed || wide ? "Show sidebar" : "Hide sidebar"}
            aria-expanded={!railClosed && !wide}
            aria-controls="rail"
            aria-keyshortcuts="["
            title="Show or hide the sidebar ["
            onClick={() => {
              if (wide) {
                setWide(false);
                setRailClosed(false);
              } else toggleRail();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2 3.5h12M2 8h12M2 12.5h12"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>
          </button>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Axiom
          </div>
        </div>
        <ThemeSwitch
          theme={data.settings?.theme}
          onPick={(theme) => void actions.saveSettings({ theme })}
        />
      </header>
      {data.error ? (
        <div className="banner" role="alert">
          <span>{data.error.message}</span>
          <button type="button" className="btn ghost sm" onClick={data.clearError}>
            Dismiss
          </button>
        </div>
      ) : null}
      <Rail
        topics={topics}
        notificationCount={notifications.length}
        health={data.health}
        active={active}
        now={now}
        collapsed={railClosed || wide}
        splitter={
          <Splitter pane={rail} axis="col" edge="end" label="Resize sidebar" className="sp-rail" />
        }
      />
      {onSettings ? (
        <main className="page" id="main" tabIndex={-1} aria-label="Settings">
          <SettingsPage />
        </main>
      ) : (
        <>
          <section
            className="list"
            aria-labelledby="list-title"
            id={selected ? undefined : "main"}
            tabIndex={selected ? undefined : -1}
          >
            <div className="list-head">
              <div className="list-title">
                {/* The open topic's title is the page's h1; without one the list is. */}
                {selected ? (
                  <h2 id="list-title">{onNotifs ? "Notifications" : VIEW_LABEL[list]}</h2>
                ) : (
                  <h1 id="list-title">{onNotifs ? "Notifications" : VIEW_LABEL[list]}</h1>
                )}
                <span className="count">{items}</span>
              </div>
              {onNotifs ? null : (
                <div className="filter">
                  <label className="sr-only" htmlFor="filter">
                    Filter topics in this list
                  </label>
                  <input
                    id="filter"
                    type="search"
                    placeholder="Filter topics"
                    autoComplete="off"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              )}
            </div>
            <Splitter
              pane={listPane}
              axis="col"
              edge="end"
              label="Resize topic list"
              className="sp-list"
            />
            <div className="list-body" tabIndex={-1}>
              {onNotifs ? (
                <NotificationsList
                  notifications={notifications}
                  titleOf={titleOf}
                  hiddenCount={data.hiddenCount}
                  now={now}
                  onOpen={openTopic}
                />
              ) : data.topics ? (
                <TopicList
                  view={list}
                  topics={topics}
                  selected={selected}
                  query={query}
                  now={now}
                  onOpen={openTopic}
                />
              ) : (
                <p className="empty">Loading.</p>
              )}
            </div>
          </section>
          <Reader
            slug={selected}
            now={now}
            backHref={list === "all" ? hrefs.all : hrefs.view(list)}
            doc={route.kind === "doc" ? route : undefined}
          />
        </>
      )}
      <StatusBar topics={topics} live={data.live} now={now} />
    </div>
  );
}

function ThemeSwitch({
  theme,
  onPick,
}: {
  theme: "dark" | "light" | "system" | undefined;
  onPick: (t: "dark" | "light") => void;
}) {
  const effective = effectiveTheme(theme);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the segmented control
    <div className="seg" role="group" aria-label="Theme">
      <button type="button" aria-pressed={effective === "dark"} onClick={() => onPick("dark")}>
        Dark
      </button>
      <button type="button" aria-pressed={effective === "light"} onClick={() => onPick("light")}>
        Light
      </button>
    </div>
  );
}
