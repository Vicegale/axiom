import { useEffect, useMemo, useState } from "react";
import { Redirect } from "wouter";
import { NotificationsList } from "../../components";
import { VIEW_LABEL } from "../../lib/domain";
import { effectiveTheme } from "../../lib/theme";
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

  // Arrow keys walk the visible list (outside text fields).
  const ordered = useMemo(() => visibleTopics(topics, list, query), [topics, list, query]);
  useEffect(() => {
    if (route.kind === "settings" || route.kind === "notifications") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (isTyping(e)) return;
      if (!ordered.length) return;
      e.preventDefault();
      const i = ordered.findIndex((t) => t.slug === selected);
      const next = e.key === "ArrowDown" ? Math.min(i + 1, ordered.length - 1) : Math.max(i - 1, 0);
      const target = ordered[i === -1 ? 0 : next];
      if (target && target.slug !== selected) goTopic(target.slug);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selected, route.kind, goTopic]);

  if (route.kind === "unknown") return <Redirect to={hrefs.all} replace />;

  const active: Active =
    route.kind === "notifications"
      ? "notifications"
      : route.kind === "settings"
        ? "settings"
        : list;
  const onNotifs = route.kind === "notifications";
  const onSettings = route.kind === "settings";
  const items = onNotifs ? notifications.length : visibleTopics(topics, list, query).length;

  return (
    <div className={`app${data.error ? " has-banner" : ""}`}>
      <header className="bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Axiom
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
      />
      {onSettings ? (
        <SettingsPage />
      ) : (
        <>
          <section className="list" aria-labelledby="list-title">
            <div className="list-head">
              <div className="list-title">
                <h2 id="list-title">{onNotifs ? "Notifications" : VIEW_LABEL[list]}</h2>
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
            <div className="list-body" tabIndex={-1}>
              {onNotifs ? (
                <NotificationsList
                  notifications={notifications}
                  titleOf={titleOf}
                  hiddenCount={data.hiddenCount}
                  now={now}
                  onOpen={goTopic}
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
          <Reader slug={selected} now={now} />
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
