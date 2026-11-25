import type { Parent } from "../api";
import { Lock } from "./Icons";

/**
 * Compact parent chip. In lists: the Jira key when there is one, otherwise the title. With
 * `detailed` (the topic header): kind tag, title, then the Jira key and status, or the manual
 * status when it is not "to do".
 */
export function ParentChip({
  parent: p,
  detailed = false,
}: {
  parent: Parent;
  detailed?: boolean;
}) {
  const kind = p.kind === "ticket" ? "Ticket" : "Epic";
  const title = `${kind}: ${p.title}`;
  if (detailed) {
    const manual = !p.jiraKey && p.status !== "to do" ? p.status : null;
    return (
      <span className="chip chip-full" title={title}>
        <span className="chip-kind">{kind}</span>
        <span className="chip-t">{p.title}</span>
        {p.jiraKey ? (
          <span className="cs">
            {p.jiraKey} {p.jiraStatus ?? ""}
          </span>
        ) : null}
        {manual ? <span className="cs">{manual}</span> : null}
        {p.locked ? <Lock /> : null}
      </span>
    );
  }
  const label = p.jiraKey ?? p.title;
  const status = p.jiraKey ? p.jiraStatus : p.status;
  return (
    <span className="chip" title={title}>
      <span className="chip-t">{label}</span>
      {status ? <span className="cs">{status}</span> : null}
      {p.locked ? <Lock /> : null}
    </span>
  );
}
