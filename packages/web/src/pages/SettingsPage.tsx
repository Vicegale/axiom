import { useState } from "react";
import type { Settings } from "../api";
import { useAxiom } from "../data/DataProvider";
import { useActions } from "../data/useActions";
import { NOTIFICATION_KINDS, type NotificationKind } from "../lib/domain";
import { browserPermission, type PermissionState } from "../lib/notify";

const LAYOUTS: { id: Settings["layout"]; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "board", label: "Board" },
  { id: "console", label: "Console" },
];
const THEMES: { id: Settings["theme"]; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

const PERMISSION_TEXT: Record<PermissionState, string> = {
  granted: "Granted. System notifications follow the mutes above.",
  denied: "Denied in this browser. Notifications show only in the notifications list.",
  default: "Not asked yet.",
  unsupported: "This browser does not support notifications.",
};

export function SettingsPage() {
  const { settings, topics } = useAxiom();
  const actions = useActions();
  const [permission, setPermission] = useState<PermissionState>(browserPermission);

  if (!settings) {
    return (
      <div className="page">
        <div className="page-inner">
          <p className="empty">Loading.</p>
        </div>
      </div>
    );
  }
  const muted = new Set<NotificationKind>(settings.mutedKinds);
  const toggleKind = (kind: NotificationKind, on: boolean) => {
    const next = NOTIFICATION_KINDS.filter((k) => (k === kind ? on : muted.has(k)));
    void actions.saveSettings({ mutedKinds: next });
  };
  const mutedTopics = (topics ?? []).filter((t) => t.muted);

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Settings</h1>
        <section className="settings" aria-label="Layout">
          <h3>Layout</h3>
          <div className="opt-list" role="radiogroup" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <label key={l.id} className="opt">
                <input
                  type="radio"
                  name="layout"
                  value={l.id}
                  checked={settings.layout === l.id}
                  onChange={() => void actions.saveSettings({ layout: l.id })}
                />
                <span>{l.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings" aria-label="Theme">
          <h3>Theme</h3>
          <div className="opt-list" role="radiogroup" aria-label="Theme">
            {THEMES.map((th) => (
              <label key={th.id} className="opt">
                <input
                  type="radio"
                  name="theme"
                  value={th.id}
                  checked={settings.theme === th.id}
                  onChange={() => void actions.saveSettings({ theme: th.id })}
                />
                <span>{th.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="settings" aria-label="Notifications">
          <h3>Notifications</h3>
          <p className="hint">
            Each kind is on by default. Turning one off hides it in the notifications list and as a
            system notification; topics still stay highlighted until you open them.
          </p>
          <div className="checks">
            {NOTIFICATION_KINDS.map((k) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={!muted.has(k)}
                  onChange={(e) => toggleKind(k, !e.target.checked)}
                />
                <span>{KIND_LABEL[k]}</span>
              </label>
            ))}
          </div>

          <h3>Muted topics</h3>
          {mutedTopics.length ? (
            <ul className="muted-list">
              {mutedTopics.map((t) => (
                <li key={t.slug}>
                  <span>{t.title}</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void actions.setMuted(t.slug, false)}
                  >
                    Unmute
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No topics are muted.</p>
          )}

          <h3>Browser notifications</h3>
          <p className="hint">
            <span
              className="st-dot"
              data-state={permission === "granted" ? "ok" : "warn"}
              aria-hidden="true"
            />
            {PERMISSION_TEXT[permission]}
          </p>
          {permission === "default" ? (
            <p>
              <button
                type="button"
                className="btn"
                onClick={() => void Notification.requestPermission().then((p) => setPermission(p))}
              >
                Allow browser notifications
              </button>
            </p>
          ) : null}
        </section>

        <section className="settings" aria-label="Stale topics">
          <h3>Stale topics</h3>
          <StaleDays
            key={settings.staleAfterDays}
            days={settings.staleAfterDays}
            onSave={(n) => void actions.saveSettings({ staleAfterDays: n })}
          />
        </section>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<NotificationKind, string> = {
  "agent stopped": "Agent stopped",
  "agent asked": "Agent asked a question",
  "monitor problem": "Monitor found a problem",
  "jira changed": "Jira status changed",
  "pr review": "PR review arrived",
  "stale prompt": "Stale prompt",
  error: "Thread error",
};

function StaleDays({ days, onSave }: { days: number; onSave: (n: number) => void }) {
  const [value, setValue] = useState(String(days));
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 365;
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && n !== days) onSave(n);
      }}
    >
      <label>
        Ask "Mark as stale?" after{" "}
        <input
          type="number"
          min={1}
          max={365}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Days idle before the prompt"
        />{" "}
        days idle.
      </label>
      <button type="submit" className="btn sm" disabled={!valid || n === days}>
        Save
      </button>
    </form>
  );
}
