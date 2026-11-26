import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ChatEffort, type ChatMessage, type ChatModel, type ChatView } from "../../api";
import { useAxiom } from "../../data/DataProvider";
import { readStored, writeStored } from "../../lib/storage";
import { effectiveTheme } from "../../lib/theme";
import { ChipMenu, type ChipOption } from "../desk/ChipMenu";
import { ReplyMarkdown } from "../desk/LazyReply";
import "../../styles/replybox.css";
import "../../styles/steward.css";

/**
 * The Steward chat (03, mockup B): a drawer from the top bar. One conversation at a time: reopening
 * the drawer shows the current chat until "New". The reply appears when Steward is done (an SSE
 * change; a slow poll covers a missed event). Model and effort are picked here and remembered per
 * browser; they are the chat's own, separate from the wakes' stage settings.
 */

const MODELS: ChipOption[] = [
  { value: "haiku", label: "Haiku", hint: "Cheapest, quick answers" },
  { value: "sonnet", label: "Sonnet", hint: "The default" },
  { value: "opus", label: "Opus", hint: "Hardest questions" },
];
const EFFORTS: ChipOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];
const MODEL_KEY = "axiom.steward.chat.model";
const EFFORT_KEY = "axiom.steward.chat.effort";
const POLL_MS = 2000;
/** The textarea grows to this many lines, then scrolls. */
const MAX_LINES = 8;
const LINE_PX = 20;

const isModel = (v: string | null): v is ChatModel =>
  v === "haiku" || v === "sonnet" || v === "opus";
const isEffort = (v: string | null): v is ChatEffort =>
  v === "low" || v === "medium" || v === "high";

function useChatChoice() {
  const [model, setModel] = useState<ChatModel>(() => {
    const v = readStored(MODEL_KEY);
    return isModel(v) ? v : "sonnet";
  });
  const [effort, setEffort] = useState<ChatEffort>(() => {
    const v = readStored(EFFORT_KEY);
    return isEffort(v) ? v : "medium";
  });
  return {
    model,
    effort,
    pickModel: (v: string) => {
      if (!isModel(v)) return;
      setModel(v);
      writeStored(MODEL_KEY, v);
    },
    pickEffort: (v: string) => {
      if (!isEffort(v)) return;
      setEffort(v);
      writeStored(EFFORT_KEY, v);
    },
  };
}

const EMPTY: ChatView = { chat: null, messages: [], running: false, error: null };

/** The "Chat" button for the top bar and the drawer it opens. */
export function StewardChat() {
  const { tick, settings } = useAxiom();
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(44);
  const button = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);

  // The drawer sits below the top bar, which wraps to two rows on a narrow window.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const bar = button.current?.closest("header");
      if (bar) setTop(Math.round(bar.getBoundingClientRect().bottom));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        ref={button}
        className="st-chat-btn"
        aria-expanded={open}
        aria-controls={open ? drawerId : undefined}
        title="Chat with Steward"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        </svg>
        <span>Chat</span>
      </button>
      {open
        ? createPortal(
            <Drawer
              id={drawerId}
              top={top}
              tick={tick}
              theme={effectiveTheme(settings?.theme)}
              onClose={close}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function Drawer({
  id,
  top,
  tick,
  theme,
  onClose,
}: {
  id: string;
  top: number;
  tick: number;
  theme: "dark" | "light";
  onClose: () => void;
}) {
  const [view, setView] = useState<ChatView>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  // "New" was pressed: nothing is shown until the first message starts the next chat.
  const [fresh, setFresh] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const choice = useChatChoice();
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the refetch trigger.
  useEffect(() => {
    if (fresh) return;
    let live = true;
    api
      .stewardChat()
      .then((v) => {
        if (!live) return;
        setView(v);
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [tick, fresh]);

  // A slow poll while a reply is awaited, in case the live connection missed the change.
  useEffect(() => {
    if (!view.running || fresh) return;
    const t = setInterval(() => {
      api
        .stewardChat()
        .then(setView)
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [view.running, fresh]);

  useEffect(() => input.current?.focus(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when messages or state change.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.messages.length, view.running, view.error]);

  // Grow with the text, up to MAX_LINES.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is what changes the height.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_PX + 8)}px`;
  }, [text]);

  const last = view.messages[view.messages.length - 1];
  const waiting = view.running || sending;
  const unanswered = !waiting && last?.role === "owner" && view.chat !== null && !fresh;

  async function send() {
    const body = text.trim();
    if (!body || waiting) return;
    setSending(true);
    setSendError(null);
    try {
      let id = fresh ? null : (view.chat?.id ?? null);
      if (id === null) {
        const started = await api.startStewardChat(choice.model, choice.effort);
        id = started.chat?.id ?? null;
        if (id === null) throw new Error("the chat did not start");
      }
      const v = await api.sendStewardChat(id, body, choice.model, choice.effort);
      setFresh(false);
      setView(v);
      setText("");
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }

  async function retry() {
    if (!view.chat) return;
    setSending(true);
    setSendError(null);
    try {
      setView(await api.retryStewardChat(view.chat.id));
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const shown = fresh ? [] : view.messages;
  return (
    <aside id={id} className="st-drawer" style={{ top }} aria-label="Chat with Steward">
      <div className="st-drawer-h">
        <h2>Chat</h2>
        <button
          type="button"
          className="btn ghost sm"
          disabled={shown.length === 0 && !fresh}
          onClick={() => {
            setFresh(true);
            setView(EMPTY);
            setText("");
            setSendError(null);
            input.current?.focus();
          }}
        >
          New
        </button>
        <button type="button" className="icon-btn" aria-label="Close chat" onClick={onClose}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m3 3 8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>
      <div
        className="st-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
      >
        {shown.length === 0 && loaded ? (
          <p className="st-chat-empty">
            Ask what is going on, tell Steward something worth keeping, or ask it to check a topic.
            A new conversation starts fresh; Steward keeps what matters on the topics or in its
            memory.
          </p>
        ) : null}
        {shown.map((m) => (
          <Message key={m.id} m={m} theme={theme} />
        ))}
        {waiting ? (
          <p className="st-acting" role="status">
            <span className="st-dot" aria-hidden="true" />
            Steward is working on it
          </p>
        ) : null}
        {!waiting && (view.error || unanswered) && !fresh ? (
          <div className="st-chat-err" role="alert">
            <span>
              {view.error
                ? `Steward could not answer: ${view.error}`
                : "Steward has not answered this yet."}
            </span>
            <button type="button" className="btn sm" onClick={() => void retry()}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
      <div className="st-foot">
        {sendError ? (
          <p className="st-chat-err" role="alert">
            {sendError}
          </p>
        ) : null}
        <form
          className="st-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={text}
            aria-label="Message Steward"
            placeholder="Ask Steward or tell it to do something"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="st-composer-row">
            <ChipMenu
              name="Model"
              display={MODELS.find((o) => o.value === choice.model)?.label ?? choice.model}
              valueText={choice.model}
              value={choice.model}
              options={MODELS}
              onChange={choice.pickModel}
            />
            <ChipMenu
              name="Effort"
              display={EFFORTS.find((o) => o.value === choice.effort)?.label ?? choice.effort}
              valueText={choice.effort}
              value={choice.effort}
              options={EFFORTS}
              onChange={choice.pickEffort}
            />
            <button
              type="submit"
              className="icon-btn st-send"
              aria-label="Send"
              disabled={!text.trim() || waiting}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function Message({ m, theme }: { m: ChatMessage; theme: "dark" | "light" }) {
  const noted = m.meta?.noted ?? [];
  const done = (m.meta?.actions ?? []).filter((a) => a.started);
  return (
    <div className={`st-msg st-msg-${m.role}`}>
      <div className="st-msg-b">
        {m.role === "owner" ? (
          <p className="st-msg-text">{m.text}</p>
        ) : (
          <div className="dv-prose st-md">
            <ReplyMarkdown text={m.text} slug="steward" theme={theme} />
          </div>
        )}
      </div>
      {noted.map((n) => (
        <p className="st-noted" key={`${n.where}-${n.memoryItemId ?? n.topic}-${n.text}`}>
          <span className="st-noted-l">Noted</span>
          <span>
            {clip(n.text, 140)}{" "}
            <span className="st-noted-to">
              →{" "}
              {n.where === "topic"
                ? `${n.topic}${n.change && n.change !== "note" ? ` (${n.change})` : ""}`
                : "memory"}
            </span>
          </span>
        </p>
      ))}
      {done.map((a) => (
        <p className="st-acting" key={`${a.kind}-${a.item ?? a.topic}`}>
          <span className="st-dot" aria-hidden="true" />
          {a.kind === "check topic" ? `Started a check of ${a.topic}` : (a.summary ?? a.kind)}
        </p>
      ))}
    </div>
  );
}
