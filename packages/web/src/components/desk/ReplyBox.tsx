import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type ComposeOptions,
  type DeskThread,
  type Effort,
  type T3Project,
} from "../../api";
import { readStored, removeStored, writeStored } from "../../lib/storage";
import { ChipMenu, type ChipOption } from "./ChipMenu";
import {
  ARROW_UP,
  CHEVRON_DOWN,
  ComposerBox,
  ComposerError,
  ComposerNote,
  ComposerText,
  ComposerToolbar,
  Glyph,
  PLUS,
  SendButton,
} from "./Composer";

export interface ReplyBoxProps {
  topicSlug: string;
  /** The thread the card has selected; null when the topic has none. */
  thread: DeskThread | null;
  threads: DeskThread[];
  /** The topic's repository link target; the default T3 project of a new thread. */
  repository?: string | null;
  /** The message was sent (or the new thread started); the Desk refreshes on its change event. */
  onSent: () => void;
  /** Expanded (the box) or collapsed (the one-line bar). The card owns it so `r` can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type NewProvider = "t3" | "claude-code";

const draftKey = (slug: string, threadId: number | null) =>
  `axiom.reply-draft:${slug}:${threadId ?? "new"}`;

const label = (t: DeskThread) => t.title?.trim() || `${t.provider} thread ${t.id}`;

interface Failure {
  message: string;
  resumeCommand?: string;
}

const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const reducedMotion = () =>
  typeof window.matchMedia !== "function" ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How long the collapse animation runs; keep in step with replybox.css. */
const COLLAPSE_MS = 140;

const NEW = "new";
/** Claude models on T3 go through the `claudeAgent` provider instance (as in the New topic dialog). */
const T3_INSTANCE = "claudeAgent";

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** The T3 project whose folder is, or contains, the repository (the deepest one wins). */
function projectFor(projects: T3Project[], repository: string | null | undefined) {
  if (!repository) return undefined;
  const repo = trimSlash(repository);
  return projects
    .filter((p) => {
      const root = trimSlash(p.workspaceRoot);
      return repo === root || repo.startsWith(`${root}/`);
    })
    .sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length)[0];
}
const PROVIDERS: ChipOption[] = [
  { value: "t3", label: "T3" },
  { value: "claude-code", label: "Claude Code" },
];

/**
 * The composer of a Desk card: a one-line bar that expands into a box with the text, and the
 * controls (target, provider, model, effort, send) inside it. It sends to the selected thread, or
 * starts a new thread attached to the topic. The draft is kept per topic and thread until sent.
 */
export function ReplyBox({
  topicSlug,
  thread,
  threads,
  repository,
  onSent,
  open,
  onOpenChange,
}: ReplyBoxProps) {
  // null is "a new thread": the target when the topic has no thread, or the owner chose it.
  const [threadId, setThreadId] = useState<number | null>(thread?.id ?? null);
  const [text, setText] = useState(() => readStored(draftKey(topicSlug, thread?.id ?? null)) ?? "");
  const [options, setOptions] = useState<ComposeOptions | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort | "">("");
  const [newProvider, setNewProvider] = useState<NewProvider>(thread?.provider ?? "t3");
  // T3 projects, fetched the first time the box is about to start a new T3 thread.
  const [projects, setProjects] = useState<T3Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const projectsAsked = useRef(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const bar = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  const wasFocused = useRef(false);
  const mac = isMac();

  const target = threads.find((t) => t.id === threadId) ?? null;
  const targetName = target ? label(target) : null;

  useEffect(() => {
    let live = true;
    api
      .composeOptions()
      .then((o) => live && setOptions(o))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const newT3 = !target && newProvider === "t3";
  useEffect(() => {
    if (!open || !newT3 || projectsAsked.current) return;
    projectsAsked.current = true;
    api
      .t3Projects()
      .then(setProjects)
      .catch((e) => setProjectsError(e instanceof Error ? e.message : String(e)));
  }, [open, newT3]);

  // Expanding focuses the text; collapsing animates out, then hands focus to the bar.
  useEffect(() => {
    if (open) {
      setClosing(false);
      wasOpen.current = true;
      area.current?.focus();
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (reducedMotion()) return;
    setClosing(true);
    const t = setTimeout(() => setClosing(false), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (open || closing) return;
    const active = document.activeElement;
    if (
      bar.current &&
      (!active || active === document.body || form.current?.contains(active)) &&
      wasFocused.current
    ) {
      bar.current.focus();
    }
    wasFocused.current = false;
  }, [open, closing]);

  // The card picked another thread: the composer follows it.
  const picked = thread?.id ?? null;
  const lastPicked = useRef(picked);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the card's selection drives it
  useEffect(() => {
    if (lastPicked.current === picked) return;
    lastPicked.current = picked;
    changeThread(picked);
  }, [picked]);

  const changeText = (value: string) => {
    setText(value);
    if (value === "") removeStored(draftKey(topicSlug, threadId));
    else writeStored(draftKey(topicSlug, threadId), value);
  };

  /** Each thread has its own draft: keep this one, show the other's. */
  function changeThread(next: number | null) {
    if (text === "") removeStored(draftKey(topicSlug, threadId));
    else writeStored(draftKey(topicSlug, threadId), text);
    setThreadId(next);
    setText(readStored(draftKey(topicSlug, next)) ?? "");
    setFailure(null);
    const t = threads.find((x) => x.id === next);
    if (t) setNewProvider(t.provider);
  }

  const collapse = () => {
    wasFocused.current = true;
    onOpenChange(false);
  };

  // Model and effort apply to a Claude Code reply and to a new Claude Code thread. T3 cannot
  // change them on an existing thread; a new T3 thread has them once a project is chosen.
  const claudeOptions = options?.providers["claude-code"];
  const t3Options = options?.providers.t3;
  const projectMode = newT3 && projects !== null;
  const project = projectMode
    ? projectId === null
      ? projectFor(projects, repository)
      : projects.find((p) => p.id === projectId)
    : undefined;
  const modelRequired = projectMode && project !== undefined && !project.hasDefaultModel;
  const t3Picker = projectMode && project !== undefined;
  const pickerOn = target ? target.provider === "claude-code" : newProvider === "claude-code";
  const modelOn = pickerOn || t3Picker;
  const modelChoices = newT3 ? t3Options : claudeOptions;
  const modelHint = modelOn
    ? undefined
    : target
      ? "T3 cannot change the model or effort of an existing thread."
      : projectMode
        ? "Choose a T3 project first."
        : "A new T3 thread uses the project's default model and effort.";
  const effortHint = modelHint ?? (t3Picker && !model ? "Choose a model first." : undefined);

  const trimmed = text.trim();
  const blocked =
    projectMode && !project
      ? "Choose a T3 project"
      : modelRequired && !model
        ? "Choose a model; this project has no default"
        : newT3 && projects === null && projectsError === null
          ? "Loading T3 projects…"
          : undefined;
  const canSend = trimmed !== "" && !sending && !blocked;

  const fail = (e: unknown) => {
    if (e instanceof ApiError) setFailure({ message: e.message, resumeCommand: e.resumeCommand });
    else setFailure({ message: e instanceof Error ? e.message : String(e) });
  };

  const done = () => {
    removeStored(draftKey(topicSlug, threadId));
    setText("");
    setFailure(null);
    onSent();
    collapse();
  };

  const pickedOptions = (provider: NewProvider) =>
    provider === "claude-code"
      ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
      : {};

  /** A new T3 thread: the chosen project, and a model on the `claudeAgent` instance. */
  const t3Body = () => ({
    ...(project ? { project: project.id } : {}),
    ...(t3Picker && model
      ? { model, providerInstance: T3_INSTANCE, ...(effort ? { effort } : {}) }
      : {}),
  });

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setFailure(null);
    try {
      if (target) {
        await api.sendToThread(target.id, { text: trimmed, ...pickedOptions(target.provider) });
      } else {
        await api.newThread(topicSlug, {
          text: trimmed,
          provider: newProvider,
          ...(newProvider === "t3" ? t3Body() : pickedOptions(newProvider)),
        });
      }
      done();
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const barLabel = targetName ? `Reply to ${targetName}…` : "Start a thread…";
  const draftLine = text.trim().split("\n")[0] ?? "";

  const targetOptions: ChipOption[] = [
    ...threads.map((t) => ({
      value: String(t.id),
      label: label(t),
      hint: t.provider === "t3" ? "T3" : "Claude Code",
    })),
    {
      value: NEW,
      label: "New thread",
      hint: "Starts a thread attached to this topic",
      separated: threads.length > 0,
    },
  ];
  const sendName = target ? `Send to ${label(target)}` : "Start a new thread";

  if (!open && !closing) {
    return (
      <button
        ref={bar}
        type="button"
        className="rc-bar"
        aria-expanded={false}
        aria-label={
          draftLine ? `${barLabel.replace("…", "")} (draft saved)` : barLabel.replace("…", "")
        }
        title={`${barLabel.replace("…", "")}  (r)`}
        onClick={() => onOpenChange(true)}
      >
        {draftLine ? (
          <>
            <span className="rc-tag">Draft</span>
            <span className="rc-bar-text rc-draft">{draftLine}</span>
          </>
        ) : (
          <span className="rc-bar-text">{barLabel}</span>
        )}
        <span className="rc-bar-send" aria-hidden="true">
          <Glyph d={ARROW_UP} />
        </span>
      </button>
    );
  }

  return (
    <div className={`rc-wrap ${open ? "in" : "out"}`}>
      <ComposerBox
        as="form"
        ref={form}
        aria-label="Reply"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <ComposerText
          ref={area}
          measureOn={open}
          aria-label={targetName ? `Message to ${targetName}` : "Message to a new thread"}
          value={text}
          placeholder={targetName ? `Reply to ${targetName}…` : "Start a thread…"}
          onChange={(e) => changeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            } else if (e.key === "Escape") {
              // The draft stays; the layouts bind Escape on the window, so keep it ours.
              e.preventDefault();
              e.stopPropagation();
              collapse();
            }
          }}
        />
        {newT3 && projectsError !== null && (
          <ComposerNote>
            Could not list T3 projects ({projectsError}). The thread starts in the topic's
            repository folder.
          </ComposerNote>
        )}
        {failure && (
          <ComposerError>
            <p>{failure.message}</p>
            {failure.resumeCommand && (
              <div className="rc-resume">
                <code>{failure.resumeCommand}</code>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void copy(failure.resumeCommand ?? "")}
                >
                  {copied ? "Copied" : "Copy command"}
                </button>
              </div>
            )}
          </ComposerError>
        )}
        <ComposerToolbar
          chips={
            <>
              <ChipMenu
                name="Thread"
                display={target ? label(target) : "New thread"}
                valueText={target ? label(target) : "new thread"}
                value={target ? String(target.id) : NEW}
                options={targetOptions}
                icon={target ? undefined : <Glyph d={PLUS} />}
                disabledReason={threads.length === 0 ? "This topic has no thread yet." : undefined}
                onChange={(v) => changeThread(v === NEW ? null : Number(v))}
              />
              {!target && (
                <ChipMenu
                  name="Provider"
                  display={newProvider === "t3" ? "T3" : "Claude Code"}
                  valueText={newProvider === "t3" ? "T3" : "Claude Code"}
                  value={newProvider}
                  options={PROVIDERS}
                  onChange={(v) => setNewProvider(v as NewProvider)}
                />
              )}
              {projectMode && (
                <ChipMenu
                  name="Project"
                  display={project?.title ?? "Project"}
                  valueText={project?.title ?? "none"}
                  muted={!project}
                  value={project?.id ?? ""}
                  options={projects.map((p) => ({
                    value: p.id,
                    label: p.title,
                    hint: p.workspaceRoot,
                  }))}
                  disabledReason={projects.length === 0 ? "T3 has no projects." : undefined}
                  onChange={(v) => setProjectId(v)}
                />
              )}
              <ChipMenu
                name="Model"
                display={model || (modelRequired ? "Model required" : "Model")}
                valueText={model || "default"}
                muted={!model}
                value={model}
                options={[
                  ...(modelRequired ? [] : [{ value: "", label: "Default" }]),
                  ...(modelChoices?.models.map((m) => ({ value: m, label: m })) ?? []),
                ]}
                disabledReason={modelHint}
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
                  ...(modelChoices?.efforts.map((x) => ({ value: x, label: x })) ?? []),
                ]}
                disabledReason={effortHint}
                onChange={(v) => setEffort(v as Effort | "")}
              />
            </>
          }
          actions={
            <>
              <span className="rc-keys" aria-hidden="true">
                {mac ? "⌘↵" : "Ctrl↵"}
              </span>
              <button
                type="button"
                className="rc-icon"
                aria-label="Collapse"
                title="Collapse (Esc). The draft is kept."
                onClick={collapse}
              >
                <Glyph d={CHEVRON_DOWN} />
              </button>
              <SendButton
                ready={canSend}
                sending={sending}
                label={sending ? "Sending…" : sendName}
                title={
                  sending ? "Sending…" : (blocked ?? `${sendName} (${mac ? "⌘↵" : "Ctrl+Enter"})`)
                }
              />
            </>
          }
        />
      </ComposerBox>
    </div>
  );
}
