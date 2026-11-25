import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  api,
  type ComposeOptions,
  type Effort,
  type EpicItem,
  type NewThreadBody,
  type TicketItem,
  type Workspace,
} from "../../api";
import type { Provider } from "../../lib/domain";
import { Modal } from "../Modal";
import "../../styles/newtopic.css";

interface Props {
  onClose: () => void;
  /** The topic exists (also when starting its thread failed): refetch the Desk. */
  onTopic: () => void;
  /** Everything went through. */
  onDone: (slug: string) => void;
}

type Phase = "idle" | "creating" | "starting";

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "t3", label: "T3" },
  { value: "claude-code", label: "Claude Code" },
];

/** Claude models on T3 go through the `claudeAgent` provider instance. */
const T3_INSTANCE = "claudeAgent";

export function NewTopicDialog({ onClose, onTopic, onDone }: Props) {
  const ids = useId();
  const id = (n: string) => `${ids}-${n}`;
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [folder, setFolder] = useState("");
  const [parent, setParent] = useState("");
  const [text, setText] = useState("");
  const [provider, setProvider] = useState<Provider>("t3");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort | "">("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ title?: string; folder?: string }>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** Set once the topic exists, so a retry only starts the thread. */
  const [created, setCreated] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [epics, setEpics] = useState<EpicItem[]>([]);
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [options, setOptions] = useState<ComposeOptions | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // The dialog opens after this effect (Modal's own): the attribute makes showModal() focus the
  // title natively; the timer covers browsers and test DOMs that ignore it.
  useEffect(() => {
    titleRef.current?.setAttribute("autofocus", "");
    const timer = setTimeout(() => titleRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let live = true;
    const ok = <T,>(p: Promise<T>, set: (v: T) => void) =>
      p.then((v) => live && set(v)).catch(() => {});
    ok(api.workspaces(), setWorkspaces);
    ok(api.epics(), setEpics);
    ok(api.tickets(), setTickets);
    ok(api.composeOptions(), setOptions);
    return () => {
      live = false;
    };
  }, []);

  const busy = phase !== "idle";
  const withMessage = text.trim() !== "";
  const choices = options?.providers[provider];
  const dirty = [title, goal, folder, parent, text].some((v) => v.trim() !== "");

  const close = () => {
    if (busy) return;
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (dirty && !created) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const pickProvider = (p: Provider) => {
    setProvider(p);
    setModel("");
    setEffort("");
  };

  const start = async (slug: string) => {
    setPhase("starting");
    const body: NewThreadBody = { text: text.trim(), provider };
    // `~` is not expanded for the provider; the topic's repository link (already absolute) is used.
    const f = folder.trim();
    if (f && !f.startsWith("~")) {
      if (provider === "t3") body.project = f;
      else body.cwd = f;
    }
    if (model) {
      body.model = model;
      if (provider === "t3") body.providerInstance = T3_INSTANCE;
      if (effort) body.effort = effort;
    }
    await api.newThread(slug, body);
  };

  const submit = async () => {
    if (busy) return;
    const next: typeof errors = {};
    if (!title.trim()) next.title = "A title is required.";
    if (withMessage && !folder.trim())
      next.folder = "Pick the project folder to start a thread in.";
    setErrors(next);
    if (next.title) return titleRef.current?.focus();
    if (next.folder) return folderRef.current?.focus();
    setError(null);
    let slug = created;
    try {
      if (!slug) {
        setPhase("creating");
        const [kind, ref] = parent.split(":");
        const topic = await api.createTopic({
          title: title.trim(),
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          ...(kind === "epic" && ref ? { epic: ref } : {}),
          ...(kind === "ticket" && ref ? { ticket: ref } : {}),
          ...(folder.trim() ? { repository: folder.trim() } : {}),
        });
        slug = topic.slug;
        setCreated(slug);
        onTopic();
      }
      if (withMessage) await start(slug);
      onDone(slug);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const retrying = created !== null && withMessage;
  const label = busy
    ? phase === "creating"
      ? "Creating…"
      : "Starting thread…"
    : retrying
      ? "Retry start"
      : withMessage
        ? "Create and start"
        : "Create topic";

  return (
    <Modal onClose={close} labelledBy={id("h")} className="nt-dialog">
      <form
        className="nt-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={onKeyDown}
      >
        <header className="nt-head">
          <h2 id={id("h")}>New topic</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>

        <div className="nt-field">
          <label htmlFor={id("title")}>Title</label>
          <input
            id={id("title")}
            ref={titleRef}
            value={title}
            disabled={created !== null}
            maxLength={200}
            aria-required="true"
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? id("title-e") : undefined}
            onChange={(e) => setTitle(e.target.value)}
          />
          {errors.title ? (
            <p className="nt-err" id={id("title-e")}>
              {errors.title}
            </p>
          ) : null}
        </div>

        <div className="nt-field">
          <label htmlFor={id("goal")}>
            Goal <span className="nt-opt">optional</span>
          </label>
          <input
            id={id("goal")}
            value={goal}
            disabled={created !== null}
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>

        <div className="nt-row">
          <div className="nt-field">
            <label htmlFor={id("folder")}>
              Project folder <span className="nt-opt">{withMessage ? "required" : "optional"}</span>
            </label>
            <input
              id={id("folder")}
              ref={folderRef}
              list={id("folders")}
              value={folder}
              disabled={created !== null}
              placeholder="~/projects/…"
              spellCheck={false}
              autoComplete="off"
              aria-required={withMessage ? true : undefined}
              aria-invalid={errors.folder ? true : undefined}
              aria-describedby={errors.folder ? id("folder-e") : undefined}
              onChange={(e) => setFolder(e.target.value)}
            />
            <datalist id={id("folders")}>
              {workspaces.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.label}
                </option>
              ))}
            </datalist>
            {errors.folder ? (
              <p className="nt-err" id={id("folder-e")}>
                {errors.folder}
              </p>
            ) : null}
          </div>
          <div className="nt-field">
            <label htmlFor={id("parent")}>
              Parent <span className="nt-opt">optional</span>
            </label>
            <select
              id={id("parent")}
              value={parent}
              disabled={created !== null}
              onChange={(e) => setParent(e.target.value)}
            >
              <option value="">None</option>
              {epics.length ? (
                <optgroup label="Epics">
                  {epics.map((e) => (
                    <option key={e.slug} value={`epic:${e.slug}`}>
                      {e.title}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {tickets.length ? (
                <optgroup label="Tickets">
                  {tickets.map((t) => (
                    <option key={t.slug} value={`ticket:${t.slug}`}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
        </div>

        <div className="nt-field">
          <label htmlFor={id("text")}>
            First message <span className="nt-opt">optional</span>
          </label>
          <textarea
            id={id("text")}
            rows={5}
            value={text}
            placeholder="What should the first thread do? Leave empty to create the topic only."
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        {withMessage ? (
          <fieldset className="nt-start">
            <legend>First thread</legend>
            <div className="nt-row">
              <div className="nt-field">
                <span className="nt-label" id={id("prov")}>
                  Provider
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: matches the Desk's other segmented controls */}
                <div className="seg" role="group" aria-labelledby={id("prov")}>
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      aria-pressed={provider === p.value}
                      onClick={() => pickProvider(p.value)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="nt-field">
                <label htmlFor={id("model")}>Model</label>
                <select id={id("model")} value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Default</option>
                  {choices?.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="nt-field">
                <label htmlFor={id("effort")}>Effort</label>
                <select
                  id={id("effort")}
                  value={effort}
                  disabled={provider === "t3" && !model}
                  onChange={(e) => setEffort(e.target.value as Effort | "")}
                >
                  <option value="">Default</option>
                  {choices?.efforts.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="nt-hint">
              {provider === "t3"
                ? `T3 uses the project's default model. A model chosen here runs on T3's "${T3_INSTANCE}" provider instance, and a project without a default model needs one.`
                : "Claude Code runs in the project folder with claude -p."}
            </p>
          </fieldset>
        ) : null}

        <div className="nt-status" role="status" aria-live="polite">
          {busy ? label : ""}
        </div>
        {error ? (
          <p className="nt-fail" role="alert">
            {created
              ? `The topic "${title.trim()}" was created, but its thread did not start: ${error}`
              : error}
          </p>
        ) : null}

        {confirmDiscard ? (
          <div className="nt-confirm" role="alert">
            <span>Discard this new topic?</span>
            <button type="button" className="btn sm" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button type="button" className="btn sm danger" onClick={onClose}>
              Discard
            </button>
          </div>
        ) : null}

        <footer className="nt-actions">
          <span className="nt-keys">Ctrl+Enter to submit</span>
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            {created ? "Close" : "Cancel"}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {label}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
