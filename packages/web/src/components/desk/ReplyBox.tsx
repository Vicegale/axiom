import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api, type ComposeOptions, type DeskThread, type Effort } from "../../api";
import { readStored, removeStored, writeStored } from "../../lib/storage";
import "../../styles/replybox.css";
import { ChipMenu, type ChipOption } from "./ChipMenu";

export interface ReplyBoxProps {
  topicSlug: string;
  /** The thread the card has selected; null when the topic has none. */
  thread: DeskThread | null;
  threads: DeskThread[];
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
const PROVIDERS: ChipOption[] = [
  { value: "t3", label: "T3" },
  { value: "claude-code", label: "Claude Code" },
];

const Glyph = ({ d }: { d: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const ARROW_UP = "M7 11.5v-9M3 6.2 7 2.2l4 4";
const CHEVRON_DOWN = "m3 5 4 4 4-4";
const PLUS = "M7 2.8v8.4M2.8 7h8.4";

/**
 * The composer of a Desk card: a one-line bar that expands into a box with the text, and the
 * controls (target, provider, model, effort, send) inside it. It sends to the selected thread, or
 * starts a new thread attached to the topic. The draft is kept per topic and thread until sent.
 */
export function ReplyBox({
  topicSlug,
  thread,
  threads,
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

  // Grow with the text, up to the CSS max-height; then the textarea scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text and the box opening are the triggers
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, open]);

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
  // change them on an existing thread, and a new T3 thread uses the project's default.
  const claudeOptions = options?.providers["claude-code"];
  const pickerOn = target ? target.provider === "claude-code" : newProvider === "claude-code";
  const pickerHint = pickerOn
    ? undefined
    : target
      ? "T3 cannot change the model or effort of an existing thread."
      : "A new T3 thread uses the project's default model and effort.";

  const trimmed = text.trim();
  const canSend = trimmed !== "" && !sending;

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
          ...pickedOptions(newProvider),
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
      <form
        ref={form}
        className="rc-box"
        aria-label="Reply"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={area}
          className="rc-text"
          aria-label={targetName ? `Message to ${targetName}` : "Message to a new thread"}
          rows={1}
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
        {failure && (
          <div className="rc-error" role="alert">
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
          </div>
        )}
        <div className="rc-bottom">
          <div className="rc-chips">
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
            <ChipMenu
              name="Model"
              display={model || "Model"}
              valueText={model || "default"}
              muted={!model}
              value={model}
              options={[
                { value: "", label: "Default" },
                ...(claudeOptions?.models.map((m) => ({ value: m, label: m })) ?? []),
              ]}
              disabledReason={pickerHint}
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
                ...(claudeOptions?.efforts.map((x) => ({ value: x, label: x })) ?? []),
              ]}
              disabledReason={pickerHint}
              onChange={(v) => setEffort(v as Effort | "")}
            />
          </div>
          <div className="rc-actions">
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
            <button
              type="submit"
              className={`rc-send${canSend ? " ready" : ""}`}
              disabled={!canSend}
              aria-busy={sending || undefined}
              aria-label={sending ? "Sending…" : sendName}
              title={sending ? "Sending…" : `${sendName} (${mac ? "⌘↵" : "Ctrl+Enter"})`}
            >
              {sending ? <span className="rc-spin" aria-hidden="true" /> : <Glyph d={ARROW_UP} />}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
