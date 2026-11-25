import { useId, useState } from "react";
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
const CAP_FAMILIES = ["haiku", "sonnet", "opus"];

interface Props {
  settings: StewardSettings;
  sources: StewardView["sources"] | undefined;
  onSave: (s: StewardSettings) => Promise<string | null>;
  onClose: () => void;
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
  return (
    <div className="st-set-row">
      <span className="st-set-label" id={`${id}-l`}>
        {label}
      </span>
      <select
        aria-label={`${label}: model`}
        value={value ? value.model : "\u0000none"}
        onChange={(e) =>
          onChange(
            e.target.value === "\u0000none"
              ? null
              : { model: e.target.value, effort: value?.effort ?? "medium" },
          )
        }
      >
        {none ? <option value={"\u0000none"}>{none}</option> : null}
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label}: effort`}
        value={value?.effort ?? "medium"}
        disabled={!value}
        onChange={(e) => value && onChange({ ...value, effort: e.target.value as Effort })}
      >
        {EFFORTS.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
    </div>
  );
}

function sourceNote(s: { on: boolean; ok: boolean | null; reason: string | null } | undefined) {
  if (!s?.on) return "Off";
  if (s.ok === null) return "Not checked yet";
  return s.ok ? "Reachable at the last wake" : (s.reason ?? "Unreachable at the last wake");
}

export function StewardSettingsDialog({ settings, sources, onSave, onClose }: Props) {
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
