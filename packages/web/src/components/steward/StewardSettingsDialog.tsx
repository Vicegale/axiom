import { type ReactNode, useId, useState } from "react";
import type { Effort, StewardSettings, StewardStageModel, StewardView } from "../../api";
import { ApiError } from "../../api";
import { Modal } from "../Modal";

const MODELS = ["haiku", "sonnet", "opus"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;
const SIGNALS: [string, string][] = [
  ["ci failed", "CI failed"],
  ["changes requested", "Changes requested"],
  ["new review comments", "New review comments"],
  ["conflict coming", "A conflict is coming"],
  ["no reviewer", "No reviewer after a few days"],
  ["ready to merge", "Approved and ready to merge"],
];
const COMPLEXITIES = ["simple", "medium", "hard"] as const;
const NONE = "\u0000none";

/** What each model choice does, shown in the pickers' tooltips. */
const MODEL_INFO: Record<string, string> = {
  haiku: "Fastest and cheapest. Good at reading and summarising a lot of text; weakest judgement.",
  sonnet: "Balanced. Good judgement at a moderate cost.",
  opus: "Strongest reasoning; slowest and most expensive. Worth it for hard fixes.",
  [NONE]:
    "Steward describes the task in a finding and does not start it. No tokens beyond deciding.",
};
/** What each effort does. */
const EFFORT_INFO: Record<Effort, string> = {
  low: "Answers with little thinking first. Fastest, fewest tokens.",
  medium: "Thinks a little before answering.",
  high: "Thinks longer. Better on tricky problems; more tokens and time.",
  xhigh: "Thinks longer still. Slower and costlier than high.",
  max: "The most thinking the model allows. Slowest, most tokens.",
};
/** What each row is for. */
const ROW_INFO: Record<string, string> = {
  Gather:
    "Stage 1, on every wake: reads what changed since the last check (topics, pull requests, connectors) and summarises it. It runs most often, so a cheap model fits.",
  Decide:
    "Stage 2, on every wake: reads the summary and decides what to tell you, how loudly, what to ask and what to promote. It needs good judgement.",
  Simple:
    "Promoted tasks Decide rates simple, such as updating a snapshot or a one-line fix: the model that prepares the fix.",
  Medium:
    "Promoted tasks Decide rates medium, such as a real bug fix across a few files: the model that prepares the fix.",
  Hard: "Promoted tasks Decide rates hard, such as a design change: the model that prepares the fix, or Report only.",
};
const label = (s: string) =>
  s === NONE
    ? "Report only"
    : s === "xhigh"
      ? "Extra high"
      : s.charAt(0).toUpperCase() + s.slice(1);
const CAP_FAMILIES = ["haiku", "sonnet", "opus"];

interface Props {
  settings: StewardSettings;
  sources: StewardView["sources"] | undefined;
  onSave: (s: StewardSettings) => Promise<string | null>;
  /** Whether a wake is running now (Run now waits for it). */
  running?: boolean;
  /** Starts a wake now; resolves true when it was started. */
  onRunNow?: () => Promise<boolean>;
  onClose: () => void;
}

/**
 * A control with a tooltip shown while it is hovered or focused (the tooltip is also its
 * accessible description).
 */
function Tip({ tip, children }: { tip: ReactNode; children: (tipId: string) => ReactNode }) {
  const id = useId();
  return (
    <span className="st-tipwrap">
      {children(id)}
      <span role="tooltip" id={id} className="st-tip">
        {tip}
      </span>
    </span>
  );
}

/** A tooltip listing every option of a picker and what it does, the current one marked. */
function OptionsTip({
  options,
  current,
  info,
}: {
  options: string[];
  current: string;
  info: Record<string, string>;
}) {
  return (
    <ul className="st-tip-list">
      {options.map((o) => (
        <li key={o} className={o === current ? "current" : undefined}>
          <b>{label(o)}</b>
          {o === current ? <span className="st-tip-now"> (selected)</span> : null}: {info[o] ?? ""}
        </li>
      ))}
    </ul>
  );
}

function ModelPick({
  label,
  value,
  onChange,
  none,
}: {
  label: string;
  value: StewardStageModel | null;
  onChange: (v: StewardStageModel | null) => void;
  /** The label of the "no model" option (only for promotion). */
  none?: string;
}) {
  const id = useId();
  const models = value && !MODELS.includes(value.model) ? [...MODELS, value.model] : MODELS;
  const modelChoices = none ? [NONE, ...models] : models;
  const model = value ? value.model : NONE;
  const effort = value?.effort ?? "medium";
  return (
    <div className="st-set-row">
      <Tip tip={ROW_INFO[label] ?? label}>
        {(tipId) => (
          // A button so keyboard users can reach it and read its tooltip; it does nothing else.
          <button
            type="button"
            className="st-set-label st-tip-target"
            id={`${id}-l`}
            aria-describedby={tipId}
          >
            {label}
          </button>
        )}
      </Tip>
      <Tip tip={<OptionsTip options={modelChoices} current={model} info={MODEL_INFO} />}>
        {(tipId) => (
          <select
            aria-label={`${label}: model`}
            aria-describedby={tipId}
            value={model}
            onChange={(e) =>
              onChange(
                e.target.value === NONE
                  ? null
                  : { model: e.target.value, effort: value?.effort ?? "medium" },
              )
            }
          >
            {none ? <option value={NONE}>{none}</option> : null}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
      </Tip>
      <Tip
        tip={
          value ? (
            <OptionsTip options={EFFORTS} current={effort} info={EFFORT_INFO} />
          ) : (
            "No effort: Report only starts nothing."
          )
        }
      >
        {(tipId) => (
          <select
            aria-label={`${label}: effort`}
            aria-describedby={tipId}
            value={effort}
            disabled={!value}
            onChange={(e) => value && onChange({ ...value, effort: e.target.value as Effort })}
          >
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
      </Tip>
    </div>
  );
}

function sourceNote(s: { on: boolean; ok: boolean | null; reason: string | null } | undefined) {
  if (!s?.on) return "Off";
  if (s.ok === null) return "Not checked yet";
  return s.ok ? "Reachable at the last wake" : (s.reason ?? "Unreachable at the last wake");
}

export function StewardSettingsDialog({
  settings,
  sources,
  onSave,
  running = false,
  onRunNow,
  onClose,
}: Props) {
  const [runNote, setRunNote] = useState("");
  const [starting, setStarting] = useState(false);
  const runNow = async () => {
    if (!onRunNow) return;
    setStarting(true);
    try {
      const ok = await onRunNow();
      setRunNote(
        ok ? "Started. Its results appear on the Steward page." : "Could not start a wake.",
      );
    } finally {
      setStarting(false);
    }
  };
  const [d, setD] = useState<StewardSettings>(settings);
  const [caps, setCaps] = useState<Record<string, string>>(() =>
    Object.fromEntries(CAP_FAMILIES.map((f) => [f, String(settings.dailyCaps[f] ?? "")])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = useId();

  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const capsOut = (): Record<string, number> | string => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(settings.dailyCaps)) {
      if (!CAP_FAMILIES.includes(k)) out[k] = v;
    }
    for (const f of CAP_FAMILIES) {
      const n = num(caps[f] ?? "");
      if (n === null) continue;
      if (!Number.isInteger(n) || n <= 0) return `The ${f} cap must be a whole number above 0.`;
      out[f] = n;
    }
    return out;
  };

  const save = async () => {
    const dailyCaps = capsOut();
    if (typeof dailyCaps === "string") return setError(dailyCaps);
    setBusy(true);
    setError(null);
    try {
      const msg = await onSave({ ...d, dailyCaps });
      if (msg) setError(msg);
      else onClose();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setHours = (p: Partial<StewardSettings["workingHours"]>) =>
    setD({ ...d, workingHours: { ...d.workingHours, ...p } });
  const toggle = <T,>(list: T[], v: T, on: boolean) =>
    on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v);

  return (
    <Modal onClose={onClose} labelledBy={title} className="st-settings">
      <form
        className="st-set-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="st-set-head">
          <h2 id={title}>Steward settings</h2>
          <button type="button" className="icon-btn" aria-label="Close settings" onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <fieldset>
          <legend>Stage models</legend>
          <ModelPick
            label="Gather"
            value={d.stages.gather}
            onChange={(v) => v && setD({ ...d, stages: { ...d.stages, gather: v } })}
          />
          <ModelPick
            label="Decide"
            value={d.stages.decide}
            onChange={(v) => v && setD({ ...d, stages: { ...d.stages, decide: v } })}
          />
        </fieldset>

        <fieldset>
          <legend>Promotion by complexity</legend>
          <p className="st-set-hint">
            The model and effort a promoted task runs on, by how hard stage 2 rates it. Report only
            means Steward describes the task and does not start it.
          </p>
          {COMPLEXITIES.map((c) => (
            <ModelPick
              key={c}
              label={c.charAt(0).toUpperCase() + c.slice(1)}
              value={d.complexity[c]}
              none="Report only"
              onChange={(v) => setD({ ...d, complexity: { ...d.complexity, [c]: v } })}
            />
          ))}
        </fieldset>

        <fieldset>
          <legend>Daily token caps</legend>
          <p className="st-set-hint">
            Per model family, counted over a calendar day. Empty is no cap.
          </p>
          <div className="st-set-grid">
            {CAP_FAMILIES.map((f) => (
              <label key={f} className="st-set-field">
                <span>{f.charAt(0).toUpperCase() + f.slice(1)}</span>
                <input
                  inputMode="numeric"
                  value={caps[f] ?? ""}
                  onChange={(e) => setCaps({ ...caps, [f]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Working hours</legend>
          <div className="st-set-grid">
            <label className="st-set-field">
              <span>From</span>
              <input
                type="time"
                value={d.workingHours.start}
                onChange={(e) => setHours({ start: e.target.value })}
              />
            </label>
            <label className="st-set-field">
              <span>To</span>
              <input
                type="time"
                value={d.workingHours.end}
                onChange={(e) => setHours({ end: e.target.value })}
              />
            </label>
            <label className="st-set-field">
              <span>Wake every (minutes)</span>
              <input
                type="number"
                min={1}
                value={d.wakeIntervalMin}
                onChange={(e) => setD({ ...d, wakeIntervalMin: Number(e.target.value) })}
              />
            </label>
          </div>
          <fieldset className="st-set-checks">
            <legend className="sr-only">Days</legend>
            {DAYS.map(([n, name]) => (
              <label key={n} className="check">
                <input
                  type="checkbox"
                  checked={d.workingHours.days.includes(n)}
                  onChange={(e) =>
                    setHours({
                      days: toggle(d.workingHours.days, n, e.target.checked).sort((a, b) => a - b),
                    })
                  }
                />
                <span>{name}</span>
              </label>
            ))}
          </fieldset>
          {onRunNow ? (
            <div className="st-set-run">
              <button
                type="button"
                className="btn"
                onClick={() => void runNow()}
                disabled={running || starting}
              >
                {running ? "Running…" : "Run now"}
              </button>
              <span className="st-set-hint">
                A full wake right away, outside working hours and even while Steward is off.
              </span>
              <span className="st-set-hint" aria-live="polite">
                {runNote}
              </span>
            </div>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>Pull request signals</legend>
          <div className="st-set-checks col">
            {SIGNALS.map(([key, label]) => (
              <label key={key} className="check">
                <input
                  type="checkbox"
                  checked={d.prSignals.includes(key)}
                  onChange={(e) =>
                    setD({ ...d, prSignals: toggle(d.prSignals, key, e.target.checked) })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Sources</legend>
          <div className="st-set-checks col">
            {(
              [
                ["github", "GitHub"],
                ["slack", "Slack"],
                ["googleDrive", "Google Drive"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="check st-source">
                <input
                  type="checkbox"
                  checked={d.sources[key]}
                  onChange={(e) =>
                    setD({ ...d, sources: { ...d.sources, [key]: e.target.checked } })
                  }
                />
                <span>{label}</span>
                <span className="st-set-hint">
                  {d.sources[key] ? sourceNote(sources?.[key]) : "Off"}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {error ? (
          <p className="st-set-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="st-set-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn st-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
