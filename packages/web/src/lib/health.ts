import type { Health } from "../api";
import { ago, stamp } from "./time";

export interface HealthRow {
  name: string;
  state: "ok" | "warn" | "off";
  text: string;
}

/** The provider health lines shown in every layout (rail, status bar). */
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
