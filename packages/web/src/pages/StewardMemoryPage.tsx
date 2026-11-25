import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { api, type MemoryEntry, type MemoryKind, type MemoryScope } from "../api";
import { SkipLink } from "../components";
import { PageSwitch } from "../components/PageSwitch";
import { MemoryMeter } from "../components/steward/MemoryMeter";
import { useAxiom } from "../data/DataProvider";
import { useActions } from "../data/useActions";
import { useResource } from "../data/useResource";
import { hrefs } from "../layouts/shared/routes";
import { useTheme } from "../lib/theme";
import { stamp } from "../lib/time";
import { useNow } from "../lib/useNow";
import "../styles/steward.css";

const KIND_LABEL: Record<MemoryKind, string> = {
  topic: "Topic",
  repo: "Repository",
  person: "Person",
};
const KIND_ORDER: MemoryKind[] = ["topic", "repo", "person"];
const slugId = (kind: string, key: string) => `mem-${kind}-${key.replace(/[^a-zA-Z0-9]+/g, "-")}`;

interface ItemActions {
  edit: (id: number, text: string) => Promise<boolean>;
  retire: (id: number) => Promise<boolean>;
  restore: (id: number) => Promise<boolean>;
  remove: (id: number) => Promise<boolean>;
}

/** One memory item: its text, where it came from, and edit, retire and delete on hover or focus. */
function MemItem({
  item,
  now,
  acts,
  retired = false,
}: {
  item: MemoryEntry;
  now: Date;
  acts: ItemActions;
  retired?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const hint = useId();

  useEffect(() => {
    const el = area.current;
    if (editing && el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    } else if (!editing && wasEditing.current) editBtn.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    if (text === item.text) return setEditing(false);
    setBusy(true);
    const ok = await acts.edit(item.id, text);
    setBusy(false);
    if (ok) setEditing(false);
  };
  const act = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    await fn();
    setBusy(false);
    setConfirming(false);
  };
  const name = item.text.length > 50 ? `${item.text.slice(0, 49)}…` : item.text;

  return (
    <li className={`st-mem-item${retired ? " retired" : ""}`}>
      {editing ? (
        <div className="st-mem-edit">
          <textarea
            ref={area}
            value={draft}
            rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 70)))}
            aria-label={`Edit memory: ${name}`}
            aria-describedby={hint}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(item.text);
                setEditing(false);
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
            }}
          />
          <div className="st-mem-edit-acts">
            <button
              type="button"
              className="btn sm st-primary"
              disabled={busy || !draft.trim()}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setDraft(item.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <span id={hint} className="st-meta">
              Ctrl+Enter saves, Esc cancels. Saving makes it yours: Steward will not delete it.
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="st-mem-main">
            <p className="st-mem-text">{item.text}</p>
            <p className="st-meta-line">
              <span className="st-meta-part">{item.source}</span>
              <span className="st-meta-part">
                <time dateTime={item.updatedAt}>{stamp(item.updatedAt, now)}</time>
              </span>
              {retired && item.retiredAt ? (
                <span className="st-meta-part">retired {stamp(item.retiredAt, now)}</span>
              ) : null}
            </p>
          </div>
          <div className="st-mem-acts">
            {confirming ? (
              <>
                <span className="st-meta">Delete for good?</span>
                <button
                  type="button"
                  className="btn sm danger"
                  disabled={busy}
                  onClick={() => void act(() => acts.remove(item.id))}
                >
                  Delete
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setConfirming(false)}>
                  Keep
                </button>
              </>
            ) : (
              <>
                {retired ? null : (
                  <button
                    type="button"
                    ref={editBtn}
                    className="btn ghost sm st-reveal"
                    aria-label={`Edit: ${name}`}
                    onClick={() => {
                      setDraft(item.text);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                )}
                {retired ? (
                  <button
                    type="button"
                    className="btn ghost sm st-reveal"
                    aria-label={`Restore: ${name}`}
                    title="Load it again"
                    disabled={busy}
                    onClick={() => void act(() => acts.restore(item.id))}
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm st-reveal"
                    aria-label={`Retire: ${name}`}
                    title="Stop loading it, but keep it"
                    disabled={busy}
                    onClick={() => void act(() => acts.retire(item.id))}
                  >
                    Retire
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost sm st-reveal"
                  aria-label={`Delete: ${name}`}
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function AddForm({
  keys,
  onAdd,
  onClose,
}: {
  keys: { topics: { slug: string; title: string }[]; repos: string[] };
  onAdd: (body: {
    scope: MemoryScope;
    attachedKind?: MemoryKind;
    attachedKey?: string;
    text: string;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<MemoryScope>("general");
  const [kind, setKind] = useState<MemoryKind>("topic");
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLSelectElement>(null);
  const list = useId();
  useEffect(() => first.current?.focus(), []);
  const attached = scope === "attached";
  const valid = text.trim() !== "" && (!attached || key.trim() !== "");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const ok = await onAdd({
      scope,
      ...(attached ? { attachedKind: kind, attachedKey: key.trim() } : {}),
      text: text.trim(),
    });
    setBusy(false);
    if (ok) onClose();
  };
  const options =
    kind === "topic" ? keys.topics.map((t) => t.slug) : kind === "repo" ? keys.repos : [];
  return (
    <form className="st-mem-add" onSubmit={submit} aria-label="Add a memory item">
      <div className="st-mem-add-row">
        <label className="st-set-field">
          Where
          <select
            ref={first}
            value={scope}
            onChange={(e) => setScope(e.target.value as MemoryScope)}
          >
            <option value="general">General</option>
            <option value="core">Core (always loaded)</option>
            <option value="attached">Attached (topic, repository or person)</option>
          </select>
        </label>
        {attached ? (
          <>
            <label className="st-set-field">
              Attached to
              <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
                {KIND_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="st-set-field">
              {kind === "topic" ? "Topic slug" : kind === "repo" ? "Repository" : "Name"}
              <input value={key} list={list} onChange={(e) => setKey(e.target.value)} />
              <datalist id={list}>
                {options.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </label>
          </>
        ) : null}
      </div>
      <label className="st-set-field">
        What Steward should remember
        <textarea value={text} rows={2} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="st-mem-edit-acts">
        <button type="submit" className="btn sm st-primary" disabled={!valid || busy}>
          Add
        </button>
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function StewardMemoryPage() {
  const data = useAxiom();
  const { tick } = data;
  useTheme(data.settings?.theme);
  const actions = useActions();
  const now = useNow();
  const view = useResource("steward-memory", api.stewardMemory, tick).data;
  const [adding, setAdding] = useState(false);
  const [tidying, setTidying] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const ids = { core: useId(), attached: useId(), general: useId(), retired: useId() };

  const acts: ItemActions = useMemo(
    () => ({
      edit: actions.editMemory,
      retire: actions.retireMemory,
      restore: actions.restoreMemory,
      remove: actions.deleteMemory,
    }),
    [actions],
  );

  const groups = useMemo(() => {
    const out = new Map<string, { kind: MemoryKind; key: string; items: MemoryEntry[] }>();
    for (const m of view?.items ?? []) {
      if (m.retiredAt || m.scope !== "attached" || !m.attachedKind || !m.attachedKey) continue;
      const id = `${m.attachedKind}:${m.attachedKey}`;
      const g = out.get(id) ?? { kind: m.attachedKind, key: m.attachedKey, items: [] };
      g.items.push(m);
      out.set(id, g);
    }
    return [...out.values()].sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key),
    );
  }, [view]);

  const tidy = async () => {
    setTidying(true);
    await actions.tidyUpMemory();
    setTidying(false);
  };

  const active = (scope: MemoryScope) =>
    (view?.items ?? []).filter((m) => m.scope === scope && !m.retiredAt);
  const core = active("core");
  const general = active("general");
  const retired = (view?.items ?? []).filter((m) => m.retiredAt);
  const last = view?.lastTidy;

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
          <Link className="btn ghost sm" href={hrefs.steward}>
            Back to Steward
          </Link>
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
      <main className="st-main" id="main" tabIndex={-1} aria-label="Steward memory">
        {!view ? (
          <p className="empty">Loading.</p>
        ) : (
          <div className="st-page st-mem-page">
            <div className="st-mem-head">
              <div>
                <h2>Memory</h2>
                <p className="st-meta">
                  What Steward keeps between wakes. Topics come first: only general knowledge lands
                  here.
                  {last
                    ? ` Last tidy-up ${stamp(last.at, now)}${last.status === "done" ? "" : ` (${last.status})`}${last.summary ? `: ${last.summary}` : ""}`
                    : " No tidy-up yet; the first runs with the day's first wake."}
                </p>
              </div>
              <div className="st-mem-head-acts">
                <button
                  type="button"
                  className="btn sm"
                  disabled={tidying || view.items.every((m) => m.retiredAt)}
                  aria-busy={tidying}
                  onClick={() => void tidy()}
                >
                  {tidying ? "Tidying…" : "Run tidy-up now"}
                </button>
                <button
                  type="button"
                  ref={addButton}
                  className="btn sm st-primary"
                  aria-expanded={adding}
                  onClick={() => setAdding(true)}
                >
                  Add
                </button>
              </div>
            </div>

            {adding ? (
              <section className="st-panel" aria-label="Add a memory item">
                <AddForm
                  keys={view.keys}
                  onAdd={actions.addMemory}
                  onClose={() => {
                    setAdding(false);
                    addButton.current?.focus();
                  }}
                />
              </section>
            ) : null}

            <section className="st-panel" aria-labelledby={ids.core}>
              <div className="st-sec-h">
                <h3 id={ids.core}>Core</h3>
                <span className="st-n">{core.length}</span>
                <span className="st-end st-meta">always loaded</span>
              </div>
              <div className="st-pad">
                <MemoryMeter used={view.coreTokens} cap={view.budget} />
                {view.overBudget ? (
                  <p className="st-meta st-warn" role="status">
                    The core is over its budget, so the oldest items are left out until the tidy-up
                    shortens it.
                  </p>
                ) : null}
                {core.length ? (
                  <ul className="st-mem-list">
                    {core.map((m) => (
                      <MemItem key={m.id} item={m} now={now} acts={acts} />
                    ))}
                  </ul>
                ) : (
                  <p className="st-empty flush">
                    Nothing in the core yet. Put here only what Steward must never miss.
                  </p>
                )}
                <div>
                  <h4 className="st-mem-sub">Index of the rest</h4>
                  {view.index.attached.length || view.index.generalCount ? (
                    <ul className="st-index" aria-label="Index of the rest of the memory">
                      {view.index.attached.map((g) => (
                        <li key={`${g.kind}:${g.key}`}>
                          <a href={`#${slugId(g.kind, g.key)}`}>
                            {g.kind} {g.key} <span className="st-n">{g.count}</span>
                          </a>
                        </li>
                      ))}
                      {view.index.general.map((line) => (
                        <li key={line}>
                          <a href={`#${ids.general}`}>{line}</a>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="st-meta">Nothing else is held.</p>
                  )}
                </div>
              </div>
            </section>

            <section className="st-panel" aria-labelledby={ids.attached}>
              <div className="st-sec-h">
                <h3 id={ids.attached}>Attached</h3>
                <span className="st-n">{groups.reduce((n, g) => n + g.items.length, 0)}</span>
                <span className="st-end st-meta">
                  loaded when the topic, repository or person comes up
                </span>
              </div>
              <div className="st-pad">
                {groups.length ? (
                  groups.map((g) => (
                    <div key={`${g.kind}:${g.key}`} className="st-mem-group">
                      <h4 id={slugId(g.kind, g.key)} className="st-mem-group-h">
                        <span className="st-mem-to">{g.kind}</span> {g.key}
                      </h4>
                      <ul className="st-mem-list">
                        {g.items.map((m) => (
                          <MemItem key={m.id} item={m} now={now} acts={acts} />
                        ))}
                      </ul>
                    </div>
                  ))
                ) : (
                  <p className="st-empty flush">
                    No attached memory. Facts about one topic, repository or person wait here.
                  </p>
                )}
              </div>
            </section>

            <section className="st-panel" id={ids.general} aria-labelledby={`${ids.general}-h`}>
              <div className="st-sec-h">
                <h3 id={`${ids.general}-h`}>General</h3>
                <span className="st-n">{general.length}</span>
                <span className="st-end st-meta">found through the index</span>
              </div>
              <div className="st-pad">
                {general.length ? (
                  <ul className="st-mem-list">
                    {general.map((m) => (
                      <MemItem key={m.id} item={m} now={now} acts={acts} />
                    ))}
                  </ul>
                ) : (
                  <p className="st-empty flush">No general memory.</p>
                )}
              </div>
            </section>

            {retired.length ? (
              <details className="st-panel st-retired">
                <summary id={ids.retired}>Retired ({retired.length})</summary>
                <div className="st-pad">
                  <p className="st-meta">
                    Not loaded any more. Restore them, or delete them for good.
                  </p>
                  <ul className="st-mem-list">
                    {retired.map((m) => (
                      <MemItem key={m.id} item={m} now={now} acts={acts} retired />
                    ))}
                  </ul>
                </div>
              </details>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
