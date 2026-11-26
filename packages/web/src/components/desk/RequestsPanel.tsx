import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  api,
  type DeskThread,
  type PendingRequest,
  type RequestAnswers,
  type RequestQuestion,
} from "../../api";
import { useAxiom } from "../../data/DataProvider";
import { useResource } from "../../data/useResource";
import "../../styles/requests.css";

const OPEN_IN_T3 =
  "T3 asks for this permission, and T3's API has no way to approve one from outside T3. Open the thread in T3 to answer it.";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The picks of one question: chosen option labels and the free text. */
interface Pick {
  labels: string[];
  other: string;
}

function answerOf(q: RequestQuestion, p: Pick | undefined): string | string[] | null {
  const other = p?.other.trim() ?? "";
  const labels = p?.labels ?? [];
  if (q.multiSelect) {
    const all = other ? [...labels, other] : labels;
    return all.length > 0 ? all : null;
  }
  if (other) return other; // typed text wins over a pick
  return labels[0] ?? null;
}

/** A T3 question the owner answers here: options as buttons, multi-select as checkboxes, "Other". */
function QuestionForm({
  request,
  busy,
  onAnswer,
}: {
  request: PendingRequest;
  busy: boolean;
  onAnswer: (answers: RequestAnswers) => void;
}) {
  const uid = useId();
  const questions = request.questions;
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  // One plain single-choice question: choosing an option answers it at once.
  const immediate = questions.length === 1 && !questions[0]?.multiSelect;
  const set = (id: string, f: (p: Pick) => Pick) =>
    setPicks((all) => ({ ...all, [id]: f(all[id] ?? { labels: [], other: "" }) }));

  const answers: RequestAnswers = {};
  let complete = true;
  for (const q of questions) {
    const a = answerOf(q, picks[q.id]);
    if (a === null) complete = false;
    else answers[q.id] = a;
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete && !busy) onAnswer(answers);
  };

  return (
    <form className="rq-form" onSubmit={submit}>
      {questions.map((q, qi) => {
        const qid = `${uid}-${qi}`;
        const p = picks[q.id];
        return (
          <fieldset className="rq-q" key={q.id} aria-busy={busy || undefined}>
            <legend className="rq-qlegend">
              {q.header ? <span className="rq-qhead">{q.header}</span> : null}
              <span className="rq-qtext">{q.question}</span>
            </legend>
            {q.options.length > 0 ? (
              <div className="rq-opts">
                {q.options.map((o, oi) => {
                  const chosen = p?.labels.includes(o.label) ?? false;
                  if (q.multiSelect) {
                    return (
                      <label className="rq-check" key={o.label} htmlFor={`${qid}-o${oi}`}>
                        <input
                          id={`${qid}-o${oi}`}
                          type="checkbox"
                          checked={chosen}
                          disabled={busy}
                          onChange={(e) =>
                            set(q.id, (x) => ({
                              ...x,
                              labels: e.target.checked
                                ? [...x.labels, o.label]
                                : x.labels.filter((l) => l !== o.label),
                            }))
                          }
                        />
                        <span>
                          <span className="rq-olabel">{o.label}</span>
                          {o.description ? <span className="rq-odesc">{o.description}</span> : null}
                        </span>
                      </label>
                    );
                  }
                  return (
                    <button
                      type="button"
                      key={o.label}
                      className="rq-opt"
                      aria-pressed={immediate ? undefined : chosen}
                      disabled={busy}
                      onClick={() => {
                        if (immediate) onAnswer({ [q.id]: o.label });
                        else
                          set(q.id, (x) => ({ ...x, labels: chosen ? [] : [o.label], other: "" }));
                      }}
                    >
                      <span className="rq-olabel">{o.label}</span>
                      {o.description ? <span className="rq-odesc">{o.description}</span> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="rq-other">
              <label htmlFor={`${qid}-other`}>
                {q.options.length > 0 ? "Other" : "Your answer"}
              </label>
              <input
                id={`${qid}-other`}
                type="text"
                value={p?.other ?? ""}
                disabled={busy}
                autoComplete="off"
                onChange={(e) =>
                  set(q.id, (x) => ({
                    ...x,
                    other: e.target.value,
                    labels: q.multiSelect ? x.labels : [],
                  }))
                }
              />
              {immediate ? (
                <button
                  type="submit"
                  className="btn sm"
                  disabled={busy || !(p?.other.trim() ?? "")}
                >
                  Send
                </button>
              ) : null}
            </div>
          </fieldset>
        );
      })}
      {immediate ? null : (
        <div className="rq-actions">
          <button type="submit" className="btn primary sm" disabled={busy || !complete}>
            Submit
          </button>
        </div>
      )}
    </form>
  );
}

/**
 * A Claude Code permission request: Allow, Deny with an optional reason, or allow with one of
 * Claude Code's "don't ask again" choices (a rule, or accepting edits for the session).
 */
function ApprovalForm({
  request,
  busy,
  onDecide,
}: {
  request: PendingRequest;
  busy: boolean;
  onDecide: (decision: "allow" | "deny", message?: string, suggestion?: number) => void;
}) {
  const choices = request.choices ?? [];
  const uid = useId();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (denying) reasonRef.current?.focus();
    else if (back.current) {
      back.current = false;
      denyRef.current?.focus(); // the form is gone: focus returns to what opened it
    }
  }, [denying]);

  return (
    <div className="rq-form">
      <p className="rq-what">
        <span className="rq-tool">{request.tool}</span>
        {request.summary && request.summary !== request.tool ? (
          <code className="rq-sum">{request.summary}</code>
        ) : null}
      </p>
      {denying ? (
        <form
          className="rq-other"
          onSubmit={(e) => {
            e.preventDefault();
            onDecide("deny", reason.trim() || undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              back.current = true;
              setDenying(false);
            }
          }}
        >
          <label htmlFor={`${uid}-why`}>Reason (optional)</label>
          <input
            id={`${uid}-why`}
            ref={reasonRef}
            type="text"
            value={reason}
            disabled={busy}
            autoComplete="off"
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" className="btn danger sm" disabled={busy}>
            Confirm deny
          </button>
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => {
              back.current = true;
              setDenying(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="rq-actions">
          <button
            type="button"
            className="btn primary sm"
            disabled={busy}
            onClick={() => onDecide("allow")}
          >
            Allow
          </button>
          <button
            ref={denyRef}
            type="button"
            className="btn sm"
            aria-expanded={false}
            disabled={busy}
            onClick={() => setDenying(true)}
          >
            Deny
          </button>
        </div>
      )}
      {!denying && choices.length > 0 ? (
        <fieldset className="rq-always" aria-busy={busy || undefined}>
          <legend className="rq-note">Allow, and don't ask again:</legend>
          {choices.map((c) => (
            <button
              type="button"
              key={c.index}
              className="btn sm"
              disabled={busy}
              onClick={() => onDecide("allow", undefined, c.index)}
            >
              {c.label}
            </button>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

/** A T3 permission request: T3's API cannot approve it, so the card links to the thread. */
function OpenInT3({ request }: { request: PendingRequest }) {
  return (
    <div className="rq-form">
      <p className="rq-what">
        <code className="rq-sum">{request.text}</code>
      </p>
      <div className="rq-actions">
        {request.openUrl ? (
          <a className="btn primary sm" href={request.openUrl} title={OPEN_IN_T3}>
            Open in T3
          </a>
        ) : (
          <span className="rq-note">Answer it in T3.</span>
        )}
        <span className="rq-note">T3 can't approve from outside; answer it there.</span>
      </div>
    </div>
  );
}

/**
 * What the selected thread waits on the owner for (questions, permission requests), above the
 * Now block. Fetched only when the thread says something is pending; refetched on every change
 * event. After an answer the request shows "Answered" until the next refresh drops it.
 */
export function RequestsPanel({ thread }: { thread: DeskThread }) {
  const uid = useId();
  const { tick } = useAxiom();
  const wanted = thread.pendingRequests > 0;
  const { data, error } = useResource(
    `requests:${thread.id}:${wanted}`,
    () => (wanted ? api.threadRequests(thread.id) : Promise.resolve({ requests: [] })),
    tick,
  );
  const [answered, setAnswered] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  /** The announcement for screen readers; stays after the request is gone. */
  const [said, setSaid] = useState("");
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusStatus = useRef(false);

  // After an answer the controls unmount: put focus on the "Answered" line instead of losing it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per answer.
  useEffect(() => {
    if (focusStatus.current) {
      focusStatus.current = false;
      statusRef.current?.focus();
    }
  }, [answered]);

  const requests = data?.requests ?? [];
  const mark = (r: PendingRequest, what: string) => {
    setAnswered((a) => ({ ...a, [r.id]: true }));
    setSaid(`${what}: ${r.kind === "question" ? (r.questions[0]?.question ?? r.text) : r.text}`);
    focusStatus.current = true;
  };

  const run = async (r: PendingRequest, what: string, call: () => Promise<unknown>) => {
    setBusy(r.id);
    setFailed((f) => {
      const { [r.id]: _, ...rest } = f;
      return rest;
    });
    try {
      await call();
      mark(r, what);
    } catch (e) {
      setFailed((f) => ({ ...f, [r.id]: message(e) }));
    } finally {
      setBusy(null);
    }
  };

  const live = (
    <div
      className="sr-only"
      role="status"
      aria-label="Answers sent"
      aria-live="polite"
      aria-atomic="true"
    >
      {said}
    </div>
  );
  if (!wanted && requests.length === 0) return said ? live : null;

  return (
    <>
      {live}
      {error && requests.length === 0 ? (
        <p className="dk-note" role="alert">
          Could not load what the agent asked: {error.message}
        </p>
      ) : null}
      {requests.map((r, i) => {
        const id = `${uid}-${i}`;
        const heading =
          r.kind === "question"
            ? "The agent asked a question"
            : r.decidable
              ? "The agent asks permission"
              : "The agent asks permission (answer in T3)";
        return (
          <section
            key={r.id}
            className={`rq${r.kind === "approval" ? " approval" : ""}`}
            aria-labelledby={`${id}-h`}
          >
            <h3 id={`${id}-h`} className="rq-h">
              {heading}
            </h3>
            {answered[r.id] ? (
              <p className="rq-done" tabIndex={-1} ref={statusRef}>
                Answered
              </p>
            ) : r.kind === "question" ? (
              <QuestionForm
                request={r}
                busy={busy === r.id}
                onAnswer={(answers) =>
                  run(r, "Answered", () => api.answerRequest(thread.id, r.id, answers))
                }
              />
            ) : r.decidable ? (
              <ApprovalForm
                request={r}
                busy={busy === r.id}
                onDecide={(decision, why, suggestion) =>
                  run(
                    r,
                    decision === "deny"
                      ? "Denied"
                      : suggestion === undefined
                        ? "Allowed"
                        : `Allowed (${r.choices.find((c) => c.index === suggestion)?.label})`,
                    () => api.decideApproval(r.id, decision, why, suggestion),
                  )
                }
              />
            ) : (
              <OpenInT3 request={r} />
            )}
            {failed[r.id] ? (
              <p className="rq-error" role="alert">
                {failed[r.id]}
                {r.provider === "t3" && r.openUrl ? (
                  <>
                    {" "}
                    <a className="btn sm" href={r.openUrl} title={OPEN_IN_T3}>
                      Open in T3
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </section>
        );
      })}
    </>
  );
}
