import { useEffect, useRef, useState } from "react";
import { ApiError, api, type ComposeOptions, type DeskThread, type Effort } from "../../api";
import { readStored, removeStored, writeStored } from "../../lib/storage";
import "../../styles/replybox.css";

export interface ReplyBoxProps {
  topicSlug: string;
  /** The thread the card has selected; null when the topic has none. */
  thread: DeskThread | null;
  threads: DeskThread[];
  /** The message was sent (or the new thread started); the Desk refreshes on its change event. */
  onSent: () => void;
  onClose: () => void;
}

type NewProvider = "t3" | "claude-code";

const draftKey = (slug: string, threadId: number | null) =>
  `axiom.reply-draft:${slug}:${threadId ?? "new"}`;

const label = (t: DeskThread) => t.title?.trim() || `${t.provider} thread ${t.id}`;

interface Failure {
  message: string;
  resumeCommand?: string;
}

/**
 * The reply box of a Desk card: sends a message to the selected thread, or starts a new thread
 * attached to the topic. The draft is kept per topic and thread until it is sent.
 */
export function ReplyBox({ topicSlug, thread, threads, onSent, onClose }: ReplyBoxProps) {
  const [threadId, setThreadId] = useState<number | null>(thread?.id ?? threads[0]?.id ?? null);
  const [text, setText] = useState(() => readStored(draftKey(topicSlug, thread?.id ?? null)) ?? "");
  const [options, setOptions] = useState<ComposeOptions | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort | "">("");
  const [newProvider, setNewProvider] = useState<NewProvider>(thread?.provider ?? "t3");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const target = threads.find((t) => t.id === threadId) ?? null;

  useEffect(() => {
    area.current?.focus();
  }, []);

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

  const changeText = (value: string) => {
    setText(value);
    if (value === "") removeStored(draftKey(topicSlug, threadId));
    else writeStored(draftKey(topicSlug, threadId), value);
  };

  /** Each thread has its own draft: keep this one, show the other's. */
  const changeThread = (next: number) => {
    if (text === "") removeStored(draftKey(topicSlug, threadId));
    else writeStored(draftKey(topicSlug, threadId), text);
    setThreadId(next);
    setText(readStored(draftKey(topicSlug, next)) ?? "");
    setFailure(null);
    const t = threads.find((x) => x.id === next);
    if (t) setNewProvider(t.provider);
  };

  // Model and effort apply to a Claude Code reply and to a new Claude Code thread. T3 cannot
  // change them on an existing thread, and a new T3 thread uses the project's default.
  const claudeOptions = options?.providers["claude-code"];
  const pickerOn = target?.provider === "claude-code" || newProvider === "claude-code";
  const pickerHint = pickerOn
    ? null
    : target
      ? "T3 cannot change the model or effort of an existing thread, and a new T3 thread uses the project's default."
      : "A new T3 thread uses the project's default model.";

  const trimmed = text.trim();
  const canSend = trimmed !== "" && !sending;

  const fail = (e: unknown) => {
    if (e instanceof ApiError) setFailure({ message: e.message, resumeCommand: e.resumeCommand });
    else setFailure({ message: e instanceof Error ? e.message : String(e) });
  };

  const done = () => {
    removeStored(draftKey(topicSlug, threadId));
    setText("");
    onSent();
    onClose();
  };

  const picked = (provider: NewProvider) =>
    provider === "claude-code"
      ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
      : {};

  const send = async () => {
    if (!canSend || !target) return;
    setSending(true);
    setFailure(null);
    try {
      await api.sendToThread(target.id, { text: trimmed, ...picked(target.provider) });
      done();
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };

  const startNew = async () => {
    if (!canSend) return;
    setSending(true);
    setFailure(null);
    try {
      await api.newThread(topicSlug, {
        text: trimmed,
        provider: newProvider,
        ...picked(newProvider),
      });
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

  return (
    <form
      className="reply-box"
      aria-label="Reply"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <p className="reply-target">
        {target ? (
          <>
            to <strong>{label(target)}</strong>
          </>
        ) : (
          "This topic has no thread yet: start a new one."
        )}
      </p>
      <textarea
        ref={area}
        className="reply-text"
        aria-label="Message"
        rows={4}
        value={text}
        placeholder="Write to the agent…  (Ctrl+Enter sends)"
        onChange={(e) => changeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="reply-row">
        {threads.length > 1 && (
          <label className="reply-field">
            <span>Thread</span>
            <select value={threadId ?? ""} onChange={(e) => changeThread(Number(e.target.value))}>
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {label(t)} ({t.provider})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="reply-field">
          <span>Model</span>
          <select value={model} disabled={!pickerOn} onChange={(e) => setModel(e.target.value)}>
            <option value="">Default</option>
            {claudeOptions?.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="reply-field">
          <span>Effort</span>
          <select
            value={effort}
            disabled={!pickerOn}
            onChange={(e) => setEffort(e.target.value as Effort | "")}
          >
            <option value="">Default</option>
            {claudeOptions?.efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="reply-field">
          <span>New thread with</span>
          <select
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value as NewProvider)}
          >
            <option value="t3">T3</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </label>
      </div>
      {pickerHint && <p className="reply-hint">{pickerHint}</p>}
      {failure && (
        <div className="reply-error" role="alert">
          <p>{failure.message}</p>
          {failure.resumeCommand && (
            <div className="reply-resume">
              <code>{failure.resumeCommand}</code>
              <button
                type="button"
                className="btn"
                onClick={() => void copy(failure.resumeCommand ?? "")}
              >
                {copied ? "Copied" : "Copy command"}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="reply-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn" disabled={!canSend} onClick={() => void startNew()}>
          New thread
        </button>
        <button type="submit" className="btn primary" disabled={!canSend || !target}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
