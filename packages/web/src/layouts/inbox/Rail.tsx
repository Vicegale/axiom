import { Link } from "wouter";
import type { Health, TopicListItem } from "../../api";
import { MAIN_VIEWS, PILES, VIEW_DOT, VIEW_LABEL, type ViewId } from "../../lib/domain";
import { ago, stamp } from "../../lib/time";
import { inView } from "../../lib/topics";
import { hrefs } from "./routes";

export type Active = "all" | ViewId | "notifications" | "settings" | null;

interface NavProps {
  href: string;
  label: string;
  count?: number;
  dot?: string;
  active: boolean;
  attn?: boolean;
  extra?: string;
}

function Nav({ href, label, count, dot, active, attn, extra }: NavProps) {
  return (
    <Link
      href={href}
      className={`nav${attn ? " has-attn" : ""}${extra ? ` ${extra}` : ""}`}
      aria-current={active ? "true" : undefined}
    >
      {dot ? <i className={`sdot ${dot}`} aria-hidden="true" /> : null}
      <span className="lbl">{label}</span>
      {count !== undefined ? <span className="n">{count}</span> : null}
    </Link>
  );
}

interface HealthRow {
  name: string;
  state: "ok" | "warn" | "off";
  text: string;
}

function t3Row(t3: Health["t3"], now: Date): HealthRow {
  if (t3.state === "ok") {
    return {
      name: "T3",
      state: "ok",
      text: t3.lastReadAt ? `Read ${ago(t3.lastReadAt, now)}` : "Connected",
    };
  }
  const label = t3.state === "untested-version" ? "Untested T3 version" : "T3 unavailable";
  return { name: "T3", state: "warn", text: t3.detail ? `${label}: ${t3.detail}` : label };
}

export function healthRows(h: Health | undefined, now: Date): HealthRow[] {
  if (!h) return [];
  const backup = h.server.lastBackupAt ? stamp(h.server.lastBackupAt, now) : "none yet";
  return [
    {
      name: "Server",
      state: "ok",
      text: `v${h.server.version} up since ${stamp(h.server.startedAt, now)} · backup ${backup}`,
    },
    h.claudeCode.lastEventAt
      ? {
          name: "Claude Code",
          state: "ok",
          text: `Last hook event ${ago(h.claudeCode.lastEventAt, now)}`,
        }
      : { name: "Claude Code", state: "warn", text: "No hook events yet" },
    t3Row(h.t3, now),
  ];
}

interface Props {
  topics: readonly TopicListItem[];
  notificationCount: number;
  health: Health | undefined;
  active: Active;
  now: Date;
}

export function Rail({ topics, notificationCount, health, active, now }: Props) {
  const count = (v: ViewId) => topics.filter((t) => inView(t, v)).length;
  return (
    <nav className="rail" aria-label="Mailboxes">
      <Nav
        href={hrefs.all}
        label={VIEW_LABEL.all}
        count={topics.length}
        active={active === "all"}
      />
      <h2 className="rail-h">Views</h2>
      {MAIN_VIEWS.map((v) => (
        <Nav
          key={v}
          href={hrefs.view(v)}
          label={VIEW_LABEL[v]}
          count={count(v)}
          dot={VIEW_DOT[v]}
          active={active === v}
          attn={v === "attention" && count(v) > 0}
        />
      ))}
      <h2 className="rail-h">Piles</h2>
      {PILES.map((v) => (
        <Nav
          key={v}
          href={hrefs.view(v)}
          label={VIEW_LABEL[v]}
          count={count(v)}
          dot={VIEW_DOT[v]}
          active={active === v}
        />
      ))}
      <Nav
        href={hrefs.notifications}
        label="Notifications"
        count={notificationCount}
        active={active === "notifications"}
        extra="nav-notifs"
      />
      <Nav href={hrefs.settings} label="Settings" active={active === "settings"} />
      <div className="health-block">
        <h2 className="rail-h" style={{ marginTop: 0 }}>
          Health
        </h2>
        <ul className="health">
          {healthRows(health, now).map((r) => (
            <li key={r.name} data-state={r.state}>
              <i className="hd" aria-hidden="true" />
              <b>{r.name}</b>
              <p>{r.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
