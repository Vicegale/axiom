import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { api, type StewardItem, type StewardSettings, type StewardView } from "../api";
import { SkipLink } from "../components";
import { Facet } from "../components/Icons";
import { PageSwitch } from "../components/PageSwitch";
import { MemoryMeter } from "../components/steward/MemoryMeter";
import { FindingItem, QuestionItem } from "../components/steward/StewardItems";
import { StewardSettingsDialog } from "../components/steward/StewardSettingsDialog";
import { useAxiom } from "../data/DataProvider";
import { useActions } from "../data/useActions";
import { useResource } from "../data/useResource";
import { hrefs } from "../layouts/shared/routes";
import { estimateTokens, familyName, STAGE_NAMES, tokens } from "../lib/steward";
import { useTheme } from "../lib/theme";
import { hm } from "../lib/time";
import { useNow } from "../lib/useNow";
import "../styles/steward.css";

function Head({
  id,
  title,
  count,
  end,
}: {
  id: string;
  title: string;
  count?: number;
  end?: React.ReactNode;
}) {
  return (
    <div className="st-sec-h">
      <h2 id={id}>{title}</h2>
      {count !== undefined ? <span className="st-n">{count}</span> : null}
      {end ? <span className="st-end">{end}</span> : null}
    </div>
  );
}

function Brief({ view }: { view: StewardView }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const stages = useId();
  const b = view.brief;
  const lastWake = view.wakes.find((w) => w.trigger !== "tidy-up");
  return (
    <section className="st-panel st-brief" aria-labelledby={id}>
      <div className="st-brief-h">
        <h2 id={id}>Since you last looked</h2>
        {b ? (
          <time className="st-meta" dateTime={b.at}>
            {hm(b.at)}
          </time>
        ) : null}
        {b ? (
          <button
            type="button"
            className="st-disclosure"
            aria-expanded={open}
            aria-controls={stages}
            onClick={() => setOpen(!open)}
          >
            wake {hm(b.wake.startedAt)} · {tokens(b.wake.tokens)} tokens
            <span aria-hidden="true">{open ? " ▾" : " ▸"}</span>
          </button>
        ) : null}
      </div>
      {b && open ? (
        <div id={stages} className="st-stages-wrap">
          {b.wake.stages.length === 0 ? (
            <p className="st-meta">No stages were recorded for this wake.</p>
          ) : (
            <table className="st-stages">
              <caption className="sr-only">Stages of the wake at {hm(b.wake.startedAt)}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Model</th>
                  <th scope="col">What it did</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {b.wake.stages.map((s, i) => (
                  <tr key={s.runId}>
                    <td>
                      {i + 1} {STAGE_NAMES[s.stage] ?? s.stage}
                    </td>
                    <td className="st-mono">
                      {s.model} {s.effort}
                    </td>
                    <td className="st-meta">{s.did}</td>
                    <td className="st-meta st-num">{tokens(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
      {b ? (
        <p className="st-lead">{b.text}</p>
      ) : !view.enabled && !lastWake ? (
        <p className="st-lead dim">
          Steward is off. Turn it on in the top bar and it wakes on its schedule, reads what changed
          and writes its brief here.
        </p>
      ) : lastWake?.status === "running" ? (
        <p className="st-lead dim">A wake is running. Its brief lands here when it is done.</p>
      ) : lastWake ? (
        <p className="st-lead dim">
          The last wake, at {hm(lastWake.startedAt)}, wrote no brief
          {lastWake.error ? `: ${lastWake.error}` : "."}
        </p>
      ) : (
        <p className="st-lead dim">
          No wakes yet.
          {view.nextWakeAt ? ` The first is due at ${hm(view.nextWakeAt)}.` : ""}
        </p>
      )}
      {view.blindSpots.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: spots have no id
        <p className="st-meta" key={i}>
          <span className="st-blind">Blind spot</span> · {s.text}
        </p>
      ))}
    </section>
  );
}

export function StewardPage() {
  const data = useAxiom();
  const { tick, settings, topics } = data;
  useTheme(data.settings?.theme);
  const actions = useActions();
  const now = useNow();
  const view = useResource("steward", api.steward, tick).data;
  const [configuring, setConfiguring] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const needsHead = useRef<HTMLHeadingElement | null>(null);
  const ids = {
    needs: useId(),
    ready: useId(),
    know: useId(),
    mem: useId(),
    use: useId(),
    wakes: useId(),
  };

  const titleOf = useMemo(() => {
    const map = new Map((topics ?? []).map((t) => [t.slug, t.title]));
    return (slug: string) => map.get(slug) ?? slug;
  }, [topics]);

  // Announce what arrives while the page is open (never the first load).
  const seen = useRef<Set<number> | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!view) return;
    const all: StewardItem[] = [...view.needs, ...view.questions, ...view.ready, ...view.info];
    const known = seen.current;
    seen.current = new Set(all.map((i) => i.id));
    if (!known) return;
    const fresh = all.filter((i) => !known.has(i.id));
    if (fresh.length) {
      setSaid(
        `Steward: ${fresh.length} new ${fresh.length === 1 ? "item" : "items"}. ${fresh
          .map((i) => i.title)
          .join(". ")}`,
      );
    }
  }, [view]);

  const afterAct = () => {
    // The item leaves the list; keep focus on the page rather than on nothing.
    const h = document.getElementById(ids.needs);
    if (h && !document.activeElement?.closest("li")) h.focus();
  };
  const dismiss = async (id: number) => {
    if (await actions.dismissSteward(id)) afterAct();
  };
  const answer = async (id: number, text: string) => {
    const ok = await actions.answerSteward(id, text);
    return ok;
  };
  const st = settings?.steward;
  const setEnabled = (enabled: boolean) => {
    if (st) void actions.saveSettings({ steward: { ...st, enabled } });
  };
  const saveSteward = async (next: StewardSettings): Promise<string | null> => {
    const ok = await actions.saveSettings({ steward: next });
    return ok ? null : "Steward's settings were not saved.";
  };

  const on = view?.enabled ?? st?.enabled ?? false;
  const next = view?.nextWakeAt ? hm(view.nextWakeAt) : null;
  const needsCount = view ? view.needs.length + view.questions.length : 0;

  return (
    <div className={`st-app${data.error ? " has-banner" : ""}`}>
      <SkipLink />
      <header className="st-bar">
        <div className="st-bar-start">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Steward</h1>
          <PageSwitch />
        </div>
        <div className="st-bar-end">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`st-toggle${on ? " on" : ""}`}
            disabled={!st}
            onClick={() => setEnabled(!on)}
          >
            <span className="st-sw" aria-hidden="true" />
            <span className="st-ic">
              <Facet size={14} />
            </span>
            <span>Steward {on ? "on" : "off"}</span>
            {on && view?.running ? <span className="st-meta">running</span> : null}
            {on && !view?.running && next ? <span className="st-meta">next {next}</span> : null}
          </button>
          <button
            type="button"
            ref={settingsButton}
            className="icon-btn st-bar-btn"
            aria-label="Steward settings"
            title="Steward settings"
            aria-haspopup="dialog"
            disabled={!st}
            onClick={() => setConfiguring(true)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" />
              <circle cx="10.5" cy="4.5" r="1.5" />
              <circle cx="5.5" cy="11.5" r="1.5" />
            </svg>
          </button>
        </div>
      </header>
      {data.error ? (
        <div className="banner" role="alert">
          <span>{data.error.message}</span>
          <button type="button" className="btn ghost sm" onClick={data.clearError}>
            Dismiss
          </button>
        </div>
      ) : null}
      <main className="st-main" id="main" tabIndex={-1} aria-label="Steward">
        {!view ? (
          <p className="empty">Loading.</p>
        ) : (
          <div className="st-page">
            <Brief view={view} />

            <div className="st-cols">
              <section className="st-panel" aria-labelledby={ids.needs}>
                <div className="st-sec-h">
                  <h2 id={ids.needs} tabIndex={-1} ref={needsHead}>
                    Needs you
                  </h2>
                  <span className="st-n">{needsCount}</span>
                </div>
                {needsCount === 0 ? (
                  <p className="st-empty">
                    {on
                      ? "Nothing needs you right now."
                      : "Nothing needs you. Steward is off, so nothing new will come."}
                  </p>
                ) : null}
                {view.needs.length ? (
                  <ul className="st-list">
                    {view.needs.map((i) => (
                      <FindingItem
                        key={i.id}
                        item={i}
                        now={now}
                        titleOf={titleOf}
                        onDismiss={dismiss}
                        onUndo={(a) => void actions.undoSteward(a)}
                      />
                    ))}
                  </ul>
                ) : null}
                {view.questions.length ? (
                  <>
                    <h3 className="st-sub">Questions</h3>
                    <ul className="st-list">
                      {view.questions.map((q) => (
                        <QuestionItem
                          key={q.id}
                          item={q}
                          now={now}
                          titleOf={titleOf}
                          onDismiss={dismiss}
                          onAnswer={answer}
                        />
                      ))}
                    </ul>
                  </>
                ) : null}
              </section>

              <div className="st-stack">
                <section className="st-panel" aria-labelledby={ids.ready}>
                  <Head id={ids.ready} title="Ready for you" count={view.ready.length} />
                  {view.ready.length ? (
                    <ul className="st-list">
                      {view.ready.map((i) => (
                        <FindingItem
                          key={i.id}
                          item={i}
                          now={now}
                          titleOf={titleOf}
                          onDismiss={dismiss}
                          onUndo={(a) => void actions.undoSteward(a)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="st-empty">
                      Nothing is ready. Fixes Steward prepares and branches it rebases for you will
                      wait here.
                    </p>
                  )}
                </section>
                <section className="st-panel" aria-labelledby={ids.know}>
                  <Head id={ids.know} title="Good to know" count={view.info.length} />
                  {view.info.length ? (
                    <ul className="st-list">
                      {view.info.map((i) => (
                        <FindingItem
                          key={i.id}
                          item={i}
                          now={now}
                          titleOf={titleOf}
                          onDismiss={dismiss}
                          onUndo={(a) => void actions.undoSteward(a)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="st-empty">Nothing to note.</p>
                  )}
                </section>
              </div>
            </div>

            <div className="st-bottom">
              <section className="st-panel" id="memory" aria-labelledby={`${ids.mem}-h`}>
                <Head
                  id={`${ids.mem}-h`}
                  title="Memory core"
                  end={
                    <Link className="btn ghost sm" href={hrefs.stewardMemory}>
                      Open memory
                    </Link>
                  }
                />
                <div className="st-pad">
                  {view.memory.length ? (
                    <>
                      <MemoryMeter
                        used={estimateTokens(view.memory.map((m) => m.text))}
                        cap={st?.memoryCoreTokens ?? 2000}
                      />
                      <ul className="st-mem">
                        {view.memory.map((m) => (
                          <li key={m.id}>{m.text}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="st-empty flush">
                      Steward has noted nothing yet. What it learns about how you work lands here.
                    </p>
                  )}
                </div>
              </section>

              <section className="st-panel" aria-labelledby={ids.use}>
                <Head id={ids.use} title="Token use today" />
                <ul className="st-pad st-usage">
                  {view.usage.map((u) => (
                    <UsageRow key={u.family} u={u} />
                  ))}
                  {view.usage.length === 0 ? (
                    <li className="st-empty flush">No calls yet today.</li>
                  ) : null}
                </ul>
              </section>

              <section className="st-panel" aria-labelledby={ids.wakes}>
                <Head
                  id={ids.wakes}
                  title="Wakes"
                  end={
                    st ? (
                      <span className="st-meta">
                        every {st.wakeIntervalMin} min, {st.workingHours.start}–
                        {st.workingHours.end}
                      </span>
                    ) : null
                  }
                />
                <div className="st-pad">
                  {view.wakes.length ? (
                    <ul className="st-wakes">
                      {view.wakes.slice(0, 5).map((w) => (
                        <li key={w.id} className="st-wk">
                          <time className="st-num" dateTime={w.startedAt}>
                            {hm(w.startedAt)}
                          </time>
                          <span>
                            {w.trigger} <span className="st-meta">· {w.summary}</span>
                          </span>
                          <span className="st-meta st-num">{tokens(w.tokens)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="st-empty flush">No wakes yet.</p>
                  )}
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
      {configuring && st ? (
        <StewardSettingsDialog
          settings={st}
          sources={view?.sources}
          onSave={saveSteward}
          onClose={() => setConfiguring(false)}
        />
      ) : null}
      <div className="sr-only" aria-live="polite">
        {said}
      </div>
    </div>
  );
}

function UsageRow({ u }: { u: StewardView["usage"][number] }) {
  const pct = u.cap ? Math.min(100, (u.used / u.cap) * 100) : 0;
  const over = u.cap !== null && u.used >= u.cap;
  const name = familyName(u.family);
  return (
    <li className="st-usage-row" title={u.models.join(", ") || undefined}>
      <span>{name}</span>
      {u.cap !== null ? (
        <span
          className={`st-meter${over ? " over" : ""}`}
          role="progressbar"
          aria-label={`${name} tokens today`}
          aria-valuemin={0}
          aria-valuemax={u.cap}
          aria-valuenow={Math.min(u.used, u.cap)}
          aria-valuetext={`${tokens(u.used)} of ${tokens(u.cap)}${over ? ", cap reached" : ""}`}
        >
          <span style={{ width: `${pct}%`, minWidth: u.used > 0 ? "2px" : 0 }} />
        </span>
      ) : (
        <span className="st-meta">no cap</span>
      )}
      <span className="st-meta st-num">
        {tokens(u.used)}
        {u.cap !== null ? ` / ${tokens(u.cap)}` : ""}
        {over ? <span className="sr-only"> (cap reached)</span> : null}
      </span>
    </li>
  );
}
