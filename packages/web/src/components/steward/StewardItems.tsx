import { useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import { api, type StewardFix, type StewardItem } from "../../api";
import { hrefs } from "../../layouts/shared/routes";
import { modelName } from "../../lib/desk";
import { rebaseInfo, statusChange } from "../../lib/steward";
import { stamp } from "../../lib/time";

interface Common {
  now: Date;
  /** Topic title by slug. */
  titleOf: (slug: string) => string;
  onDismiss: (id: number) => void;
  /** Adopt, Diff's sibling and Discard of a prepared fix (ST6); each returns whether it worked. */
  onAdopt?: (id: number) => Promise<boolean>;
  onDiscard?: (id: number) => Promise<boolean>;
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

/** The fix's one line: what it is for, its size, the tests and the model that wrote it. */
export function fixMeta(fix: StewardFix): string {
  return [
    fix.forRef ? `for ${fix.forRef}` : null,
    fix.diffstat,
    fix.tests ? `tests ${fix.tests}` : null,
    fix.model ? `${modelName(fix.model)}${fix.effort ? ` ${fix.effort}` : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A diff as lines, coloured by what they do. Rendered as text only. */
function DiffText({ diff }: { diff: string }) {
  // The file's name line stays; the index and ---/+++ lines only repeat it.
  const lines = diff
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => !/^(index |--- |\+\+\+ )/.test(l));
  return (
    <>
      {lines.map((l, i) => {
        const kind =
          l.startsWith("+++") ||
          l.startsWith("---") ||
          l.startsWith("diff ") ||
          l.startsWith("index ")
            ? "ctx"
            : l.startsWith("+")
              ? "add"
              : l.startsWith("-")
                ? "del"
                : "ctx";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
          <span key={i} className={`d-${kind}`}>
            {l}
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </>
  );
}

/** Diff, loaded when first opened. */
function useDiff(id: number) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    { diff: string; truncated: boolean } | { error: string } | null
  >(null);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !state) {
      api.stewardDiff(id).then(
        (d) => setState({ diff: d.diff, truncated: d.truncated }),
        (e) => setState({ error: e instanceof Error ? e.message : String(e) }),
      );
    }
  };
  return { open, state, toggle };
}

function DiffView({
  id,
  diff,
  ready,
}: {
  id: string;
  diff: ReturnType<typeof useDiff>;
  ready: boolean;
}) {
  if (!diff.open) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a scrollable <pre> must be a keyboard-reachable named region
    <pre
      className="diff"
      id={id}
      role="region"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: so a keyboard user can scroll a long diff
      tabIndex={0}
      aria-label="The fix's diff"
      aria-busy={!ready}
    >
      {diff.state === null ? (
        "Loading."
      ) : "error" in diff.state ? (
        diff.state.error
      ) : (
        <>
          <DiffText diff={diff.state.diff || "(no changes)"} />
          {diff.state.truncated ? "\n… the diff is cut here; see the branch for the rest." : ""}
        </>
      )}
    </pre>
  );
}

/** Adopt, Diff and Discard for a fix; Adopt's refusal reason reaches the banner. */
function FixActions({
  fix,
  diff,
  diffId,
  onAdopt,
  onDiscard,
  discardAs,
}: {
  fix: StewardFix;
  diff: ReturnType<typeof useDiff>;
  diffId: string;
  onAdopt: (id: number) => Promise<boolean>;
  onDiscard: (id: number) => Promise<boolean>;
  discardAs: "button" | "icon";
}) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: (id: number) => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    await fn(fix.itemId);
    setBusy(false);
  };
  return (
    <>
      <button
        type="button"
        className="btn sm st-primary"
        title={
          fix.kind === "rebase copy"
            ? "Moves your branch to the rebased copy locally; the old tip is saved. Pushing stays yours."
            : "Applies it to your branch locally. Pushing stays yours."
        }
        disabled={busy}
        onClick={() => void act(onAdopt)}
      >
        Adopt<span className="sr-only"> the fix on {fix.branch}</span>
      </button>
      <button
        type="button"
        className="btn sm"
        aria-expanded={diff.open}
        aria-controls={diffId}
        onClick={diff.toggle}
      >
        Diff
      </button>
      {discardAs === "button" ? (
        <button
          type="button"
          className="btn sm ghost"
          disabled={busy}
          onClick={() => void act(onDiscard)}
        >
          Discard<span className="sr-only"> the fix on {fix.branch}</span>
        </button>
      ) : null}
    </>
  );
}

/** A prepared fix inside its finding (mockup B): branch, one line about it, Adopt, Diff, Discard. */
export function FixBlock({
  fix,
  onAdopt,
  onDiscard,
}: {
  fix: StewardFix;
  onAdopt: (id: number) => Promise<boolean>;
  onDiscard: (id: number) => Promise<boolean>;
}) {
  const diff = useDiff(fix.itemId);
  const diffId = useId();
  return (
    <div className="st-fix">
      <div className="st-fix-h">
        <code className="st-br">{fix.branch}</code>
        <span className="st-meta">{fixMeta(fix)}</span>
      </div>
      <DiffView id={diffId} diff={diff} ready={diff.state !== null} />
      <div className="st-fix-acts">
        <FixActions
          fix={fix}
          diff={diff}
          diffId={diffId}
          onAdopt={onAdopt}
          onDiscard={onDiscard}
          discardAs="button"
        />
      </div>
    </div>
  );
}

/** A suggestion that stands alone (Ready for you): its title, branch and Adopt, Diff; Discard on hover. */
export function SuggestionItem({
  item,
  now,
  titleOf,
  onAdopt,
  onDiscard,
}: Pick<Common, "now" | "titleOf"> & {
  item: StewardItem;
  onAdopt: (id: number) => Promise<boolean>;
  onDiscard: (id: number) => Promise<boolean>;
}) {
  const fix = item.fix;
  const diff = useDiff(item.id);
  const diffId = useId();
  if (!fix) return null;
  return (
    <li className="st-item">
      <div className="st-item-main">
        <h3 className="st-item-title">{item.title}</h3>
        <p className="st-meta-line">
          <span className="st-meta-part">
            <code className="st-br">{fix.branch}</code>
          </span>
          <span className="st-meta-part">{fixMeta(fix)}</span>
          {item.topicSlug ? (
            <span className="st-meta-part">
              <Link href={hrefs.topic(item.topicSlug)} className="st-tlink">
                {titleOf(item.topicSlug)}
              </Link>
            </span>
          ) : null}
          <span className="st-meta-part">
            <time dateTime={item.createdAt}>{stamp(item.createdAt, now)}</time>
          </span>
        </p>
        <DiffView id={diffId} diff={diff} ready={diff.state !== null} />
        <div className="st-fix-acts">
          <FixActions
            fix={fix}
            diff={diff}
            diffId={diffId}
            onAdopt={onAdopt}
            onDiscard={onDiscard}
            discardAs="icon"
          />
        </div>
      </div>
      <div className="st-item-acts">
        <button
          type="button"
          className="icon-btn st-reveal"
          aria-label={`Discard: ${item.title}`}
          title="Discard"
          onClick={() => void onDiscard(fix.itemId)}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </li>
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
  if (item.note) parts.push(<span key="note">{item.note}</span>);
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
  onAdopt,
  onDiscard,
  onUndo,
}: Common & { item: StewardItem; onUndo: (actionId: number) => void }) {
  const change = statusChange(item);
  const rebase = rebaseInfo(item);
  return (
    <li className={`st-item${item.level ? ` lv-${item.level}` : ""}`}>
      <div className="st-item-main">
        <h3 className="st-item-title">
          {item.level === "urgent" ? <span className="st-lvl">Urgent</span> : null}
          {item.title}
        </h3>
        {item.body ? <p className="st-item-text dim">{item.body}</p> : null}
        {item.prepared && onAdopt && onDiscard ? (
          <FixBlock fix={item.prepared} onAdopt={onAdopt} onDiscard={onDiscard} />
        ) : null}
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
        {rebase && item.action ? (
          <div className="st-did">
            <span>
              Rebased <code className="st-br">{rebase.branch}</code> onto {rebase.base} locally
              (clean). Pushing is yours.
            </span>
            <button
              type="button"
              className="st-link-btn"
              onClick={() => onUndo(item.action?.id ?? 0)}
            >
              Undo<span className="sr-only"> the rebase of {rebase.branch}</span>
            </button>
            <details className="st-details">
              <summary>Details</summary>
              <code>
                {rebase.oldTip.slice(0, 7)} → {rebase.newTip.slice(0, 7)} · old tip saved at{" "}
                {rebase.backupRef}
              </code>
            </details>
          </div>
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
