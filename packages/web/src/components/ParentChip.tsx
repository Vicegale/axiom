import type { Parent } from "../api";
import { Lock } from "./Icons";

/** Compact parent chip for lists: the Jira key when there is one, otherwise the title. */
export function ParentChip({ parent: p }: { parent: Parent }) {
  const label = p.jiraKey ?? p.title;
  const status = p.jiraKey ? p.jiraStatus : p.status;
  return (
    <span className="chip" title={`${p.kind === "ticket" ? "Ticket" : "Epic"}: ${p.title}`}>
      <span className="chip-t">{label}</span>
      {status ? <span className="cs">{status}</span> : null}
      {p.locked ? <Lock /> : null}
    </span>
  );
}
