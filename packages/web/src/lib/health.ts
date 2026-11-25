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
    {
      name: "T3",
      state: h.t3.state === "ok" ? "ok" : h.t3.state === "not-configured" ? "off" : "warn",
      text: h.t3.state === "not-configured" ? "Not configured" : h.t3.state,
    },
  ];
}
