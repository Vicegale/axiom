import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  api,
  type ComposeOptions,
  type Effort,
  type EpicItem,
  type NewThreadBody,
  type PermissionMode,
  type T3Project,
  type TicketItem,
  type Workspace,
} from "../../api";
import type { Provider } from "../../lib/domain";
import {
  PERMISSION_MODE_OPTIONS,
  permissionModeLabel,
  T3_PERMISSIONS_HINT,
} from "../../lib/permissionModes";
import { Modal } from "../Modal";
import { ChipMenu, type ChipOption } from "./ChipMenu";
import {
  ComposerBox,
  ComposerError,
  ComposerNote,
  ComposerText,
  ComposerToolbar,
  FOLDER,
  Glyph,
  SendButton,
} from "./Composer";
import { detectHome, folderGroups, PathPicker, projectGroups } from "./PathPicker";
import "../../styles/newtopic.css";

interface Props {
  onClose: () => void;
  /** The topic exists (also when starting its thread failed): refetch the Desk. */
  onTopic: () => void;
  /** Everything went through. */
  onDone: (slug: string) => void;
}

type Phase = "idle" | "creating" | "starting";

const PROVIDERS: (ChipOption & { value: Provider })[] = [
  { value: "t3", label: "T3" },
  { value: "claude-code", label: "Claude Code" },
];

/** Claude models on T3 go through the `claudeAgent` provider instance. */
const T3_INSTANCE = "claudeAgent";

const norm = (p: string) => p.trim().replace(/(.)\/+$/, "$1");

/** The chip option that reveals the inline path input. */
const TYPE_PATH = "\u0000type-a-path";
const baseName = (p: string) => norm(p).split("/").filter(Boolean).pop() ?? p;

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
  const [mode, setMode] = useState<PermissionMode | "">("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  /** The error came from starting the thread: it shows inside the composer. */
  const [errorInBox, setErrorInBox] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; folder?: string; model?: string }>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** Set once the topic exists, so a retry only starts the thread. */
  const [created, setCreated] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [epics, setEpics] = useState<EpicItem[]>([]);
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  /** `null` while loading or when T3 cannot be read (then `t3Error` says why). */
  const [t3Projects, setT3Projects] = useState<T3Project[] | null>(null);
  const [t3Error, setT3Error] = useState<string | null>(null);
  /** The owner asked to type a folder path instead of picking a suggestion. */
  const [typingPath, setTypingPath] = useState(false);
  const [options, setOptions] = useState<ComposeOptions | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const projectChip = useRef<HTMLButtonElement>(null);
  const folderChip = useRef<HTMLButtonElement>(null);
  const modelChip = useRef<HTMLButtonElement>(null);

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
    api
      .t3Projects()
      .then((v) => live && setT3Projects(v))
      .catch((e) => live && setT3Error(e instanceof Error ? e.message : String(e)));
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

  // The folder is the one value: a T3 project is the one whose folder it is. With a first T3
  // thread the project must come from T3's own list; otherwise the folder is used as typed.
  const t3List = provider === "t3" && t3Projects !== null;
  const useSelect = withMessage && t3List;
  const project = t3List ? t3Projects?.find((p) => p.workspaceRoot === norm(folder)) : undefined;
  const folderValue = useSelect ? (project?.workspaceRoot ?? "") : folder.trim();
  const modelRequired = useSelect && project !== undefined && !project.hasDefaultModel;
  const folderMode =
    provider === "claude-code" || (provider === "t3" && t3Projects === null && t3Error !== null);
  const home = detectHome(
    workspaces,
    t3Projects?.map((p) => p.workspaceRoot),
  );
  const suggestions: { path: string; title: string; label: string }[] = [
    ...(t3Projects?.map((p) => ({ path: p.workspaceRoot, title: p.title, label: p.title })) ?? []),
    ...workspaces
      .filter((w) => !t3Projects?.some((p) => p.workspaceRoot === w.path))
      .map((w) => ({ path: w.path, title: baseName(w.path), label: w.label })),
  ];
  const suggested = suggestions.find((x) => x.path === norm(folder));
  const pathOpen = folderMode && (typingPath || (folder.trim() !== "" && !suggested));
  const effortHint =
    provider === "t3" && !model ? "Choose a model first: T3 applies effort to a model." : undefined;
  const ready =
    title.trim() !== "" && withMessage && folderValue !== "" && (!modelRequired || !!model);
  const sendBlocked = !title.trim()
    ? "Give the topic a title first."
    : !withMessage
      ? "Write the first message to start a thread."
      : provider === "t3" && t3Projects === null && !t3Error
        ? "Loading T3 projects…"
        : !folderValue
          ? useSelect
            ? "Choose a T3 project."
            : "Pick the folder to start the thread in."
          : modelRequired && !model
            ? "Choose a model: this project has no default."
            : undefined;

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
    if (useSelect && project) body.project = project.id;
    else {
      // `~` is not expanded for the provider; the topic's repository link (already absolute) is used.
      const f = folder.trim();
      if (f && !f.startsWith("~")) {
        if (provider === "t3") body.project = f;
        else body.cwd = f;
      }
    }
    if (model) {
      body.model = model;
      if (provider === "t3") body.providerInstance = T3_INSTANCE;
      if (effort) body.effort = effort;
    }
    if (provider === "claude-code" && mode) body.permissionMode = mode;
    await api.newThread(slug, body);
  };

  const submit = async () => {
    if (busy) return;
    const next: typeof errors = {};
    if (!title.trim()) next.title = "A title is required.";
    if (withMessage && !folderValue)
      next.folder = useSelect
        ? "Choose the T3 project to start a thread in."
        : "Pick the project folder to start a thread in.";
    if (modelRequired && !model) next.model = "This project has no default model: choose one.";
    setErrors(next);
    if (next.title) return titleRef.current?.focus();
    if (next.folder) {
      if (useSelect) return projectChip.current?.focus();
      return (pathOpen ? pathRef : folderChip).current?.focus();
    }
    if (next.model) return modelChip.current?.focus();
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
          ...(folderValue ? { repository: folderValue } : {}),
        });
        slug = topic.slug;
        setCreated(slug);
        onTopic();
      }
      if (withMessage) await start(slug);
      onDone(slug);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setErrorInBox(slug !== null);
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

        <div className="nt-row nt-meta">
          <div className="nt-field nt-goal">
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

        <ComposerBox className="nt-composer">
          <ComposerText
            ref={textRef}
            aria-label="First message"
            value={text}
            placeholder="First message for the agent (optional)"
            onChange={(e) => setText(e.target.value)}
          />
          {pathOpen ? (
            <div className="nt-path">
              <label htmlFor={id("path")}>Folder</label>
              <input
                id={id("path")}
                ref={pathRef}
                value={folder}
                disabled={created !== null}
                placeholder="~/projects/…"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors.folder ? true : undefined}
                onChange={(e) => setFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    textRef.current?.focus();
                  }
                }}
              />
            </div>
          ) : null}
          {provider === "t3" && t3Error && withMessage ? (
            <ComposerNote>
              Could not list T3 projects ({t3Error}). Type the project's folder instead.
            </ComposerNote>
          ) : model && provider === "t3" ? (
            <ComposerNote>
              Runs on T3's Claude provider ("{T3_INSTANCE}", or the project's own Claude instance
              when that one is off).
            </ComposerNote>
          ) : modelRequired ? (
            <ComposerNote>This project has no default model, so one is required.</ComposerNote>
          ) : null}
          {withMessage && errors.folder ? <ComposerError>{errors.folder}</ComposerError> : null}
          {withMessage && errors.model ? <ComposerError>{errors.model}</ComposerError> : null}
          {error && errorInBox ? (
            <ComposerError>
              The topic "{title.trim()}" was created, but its thread did not start: {error}
            </ComposerError>
          ) : null}
          <ComposerToolbar
            chips={
              <>
                <ChipMenu
                  name="Provider"
                  display={provider === "t3" ? "T3" : "Claude Code"}
                  valueText={provider === "t3" ? "T3" : "Claude Code"}
                  value={provider}
                  options={PROVIDERS}
                  onChange={(v) => pickProvider(v as Provider)}
                />
                {folderMode ? (
                  <PathPicker
                    name="Folder"
                    buttonRef={folderChip}
                    display={folder.trim() ? (suggested?.title ?? baseName(folder)) : "Folder"}
                    valueText={folder.trim() || "none"}
                    tooltip={folder.trim() || undefined}
                    muted={!folder.trim()}
                    value={suggested?.path ?? ""}
                    icon={<Glyph d={FOLDER} />}
                    groups={folderGroups(t3Projects, workspaces)}
                    home={home}
                    allowPath
                    action={{ value: TYPE_PATH, label: "Type a path…" }}
                    onAction={() => {
                      setTypingPath(true);
                      setTimeout(() => pathRef.current?.focus(), 0);
                    }}
                    disabledReason={created !== null ? "The topic already exists." : undefined}
                    onChange={(v) => {
                      setTypingPath(false);
                      setFolder(v);
                    }}
                  />
                ) : (
                  <PathPicker
                    name="Project"
                    buttonRef={projectChip}
                    display={project?.title ?? "Project"}
                    valueText={project?.title ?? "none"}
                    tooltip={project?.workspaceRoot}
                    muted={!project}
                    value={project?.id ?? ""}
                    icon={<Glyph d={FOLDER} />}
                    groups={projectGroups(t3Projects ?? [], workspaces)}
                    home={home}
                    disabledReason={
                      created !== null
                        ? "The topic already exists."
                        : t3Projects === null
                          ? "Loading T3 projects…"
                          : t3Projects.length === 0
                            ? "T3 has no projects."
                            : undefined
                    }
                    onChange={(v) => {
                      const p = t3Projects?.find((x) => x.id === v);
                      if (p) setFolder(p.workspaceRoot);
                    }}
                  />
                )}
                <ChipMenu
                  name="Model"
                  buttonRef={modelChip}
                  display={model || (modelRequired ? "Model required" : "Model")}
                  valueText={model || (modelRequired ? "required" : "default")}
                  muted={!model}
                  value={model}
                  options={[
                    ...(modelRequired ? [] : [{ value: "", label: "Default" }]),
                    ...(choices?.models.map((m) => ({ value: m, label: m })) ?? []),
                  ]}
                  onChange={setModel}
                />
                <ChipMenu
                  name="Effort"
                  display={effort || "Effort"}
                  valueText={effort || "default"}
                  muted={!effort}
                  value={effort}
                  options={[
                    { value: "", label: "Default" },
                    ...(choices?.efforts.map((x) => ({ value: x, label: x })) ?? []),
                  ]}
                  disabledReason={effortHint}
                  onChange={(v) => setEffort(v as Effort | "")}
                />
                <ChipMenu
                  name="Permissions"
                  display={
                    mode && provider === "claude-code" ? permissionModeLabel(mode) : "Permissions"
                  }
                  valueText={
                    mode && provider === "claude-code" ? permissionModeLabel(mode) : "default (Ask)"
                  }
                  muted={!mode || provider !== "claude-code"}
                  value={mode}
                  options={PERMISSION_MODE_OPTIONS}
                  disabledReason={provider === "claude-code" ? undefined : T3_PERMISSIONS_HINT}
                  onChange={(v) => setMode(v as PermissionMode)}
                />
              </>
            }
            actions={
              <SendButton
                ready={ready && !busy}
                sending={phase === "starting"}
                label={retrying ? "Retry start" : "Create and start"}
                title={busy ? label : (sendBlocked ?? `${label} (Ctrl+Enter)`)}
                disabled={!ready || busy}
              />
            }
          />
        </ComposerBox>

        <div className="nt-status" role="status" aria-live="polite">
          {busy ? label : ""}
        </div>
        {error && !errorInBox ? (
          <p className="nt-fail" role="alert">
            {error}
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
