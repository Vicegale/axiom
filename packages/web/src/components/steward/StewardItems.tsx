import { useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import type { StewardItem } from "../../api";
import { hrefs } from "../../layouts/shared/routes";
import { statusChange } from "../../lib/steward";
import { stamp } from "../../lib/time";

interface Common {
  now: Date;
  /** Topic title by slug. */
  titleOf: (slug: string) => string;
  onDismiss: (id: number) => void;
}

function Dismiss({ item, onDismiss }: { item: StewardItem; onDismiss: (id: number) => void }) {
  return (
    <button
      type="button"
      className="icon-btn st-reveal"
      aria-label={`Dismiss: ${item.title}`}
      title="Dismiss"
      onClick={() => onDismiss(item.id)}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}

function Meta({ item, now, titleOf }: Pick<Common, "now" | "titleOf"> & { item: StewardItem }) {
  const parts: React.ReactNode[] = [];
  // A question says what kind it is: a judgement call, or a blind spot Steward found.
  if (item.kind === "question" && item.signal) {
    parts.push(
      <span key="kind" className={`st-kind${item.signal === "blind spot" ? " blind" : ""}`}>
        {item.signal}
      </span>,
    );
  }
  if (item.topicSlug) {
    parts.push(
      <Link key="topic" href={hrefs.topic(item.topicSlug)} className="st-tlink">
        {titleOf(item.topicSlug)}
      </Link>,
    );
  }
  if (item.source) parts.push(<span key="src">{item.source}</span>);
  parts.push(
    <time key="at" dateTime={item.createdAt}>
      {stamp(item.createdAt, now)}
    </time>,
  );
  if (item.notified) parts.push(<span key="n">desktop notified</span>);
  return (
    <p className="st-meta-line">
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed short list
        <span key={i} className="st-meta-part">
          {p}
        </span>
      ))}
    </p>
  );
}

/** A finding: title (with an "Urgent" tag), body, what Steward did, and where it was found. */
export function FindingItem({
  item,
  now,
  titleOf,
  onDismiss,
  onUndo,
}: Common & { item: StewardItem; onUndo: (actionId: number) => void }) {
  const change = statusChange(item);
  return (
    <li className={`st-item${item.level ? ` lv-${item.level}` : ""}`}>
      <div className="st-item-main">
        <h3 className="st-item-title">
          {item.level === "urgent" ? <span className="st-lvl">Urgent</span> : null}
          {item.title}
        </h3>
        {item.body ? <p className="st-item-text dim">{item.body}</p> : null}
        {/* A prepared fix (ST6) will sit here, inside its finding. */}
        {change && item.action ? (
          <p className="st-did">
            <span className="st-status">{change.from ?? "none"}</span>
            <span aria-hidden="true">→</span>
            <span className="sr-only"> to </span>
            <span className="st-status">{change.to}</span>
            <span>by Steward</span>
            <button
              type="button"
              className="st-link-btn"
              onClick={() => onUndo(item.action?.id ?? 0)}
            >
              Undo<span className="sr-only"> moving to {change.to}</span>
            </button>
          </p>
        ) : null}
        <Meta item={item} now={now} titleOf={titleOf} />
      </div>
      <div className="st-item-acts">
        <Dismiss item={item} onDismiss={onDismiss} />
      </div>
    </li>
  );
}

/** A question, answered in place: Answer opens a focused field with Send and Cancel. */
export function QuestionItem({
  item,
  now,
  titleOf,
  onDismiss,
  onAnswer,
}: Common & { item: StewardItem; onAnswer: (id: number, text: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const field = useId();

  const refocus = useRef(false);
  const close = () => {
    refocus.current = true;
    setOpen(false);
    setText("");
  };
  // The Answer button comes back once the field closes: put focus on it then.
  useEffect(() => {
    if (!open && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [open]);
  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    const ok = await onAnswer(item.id, v);
    setBusy(false);
    if (ok) close();
  };

  return (
    <li className="st-item">
      <div className="st-item-main">
        <p className="st-item-text">{item.title}</p>
        {item.body ? <p className="st-item-text dim">{item.body}</p> : null}
        <Meta item={item} now={now} titleOf={titleOf} />
        {open ? (
          <form
            className="st-answer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            <label htmlFor={field} className="sr-only">
              Your answer to: {item.title}
            </label>
            <input
              id={field}
              // biome-ignore lint/a11y/noAutofocus: the field opens on the owner's click
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
            />
            <button type="submit" className="btn sm st-primary" disabled={busy || !text.trim()}>
              Send
            </button>
            <button type="button" className="btn sm ghost" onClick={close}>
              Cancel
            </button>
          </form>
        ) : null}
      </div>
      <div className="st-item-acts">
        {open ? null : (
          <button
            type="button"
            ref={button}
            className="btn sm"
            aria-label={`Answer: ${item.title}`}
            onClick={() => setOpen(true)}
          >
            Answer
          </button>
        )}
        <Dismiss item={item} onDismiss={onDismiss} />
      </div>
    </li>
  );
}
