import type { Entry, Thread, TopicDetail, TopicStatus, TopicSummary } from "@axiom/core";

const useColor = (): boolean => process.stdout.isTTY === true && !process.env.NO_COLOR;

const STATUS_COLORS: Record<TopicStatus, number> = {
  wip: 34,
  hitl: 33,
  error: 31,
  monitoring: 36,
  review: 36,
  blocked: 35,
  done: 32,
  idle: 90,
  stale: 90,
};

export function paint(text: string, status: TopicStatus | null): string {
  if (!status || !useColor()) return text;
  return `\x1b[${STATUS_COLORS[status]}m${text}\x1b[0m`;
}

export const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/** Aligned columns; the last column is not padded. Colours are applied after padding. */
export function table(
  rows: string[][],
  colour?: (row: number, col: number, cell: string) => string,
) {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (i < row.length - 1) widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row, r) =>
      row
        .map((cell, c) => {
          const padded = c < row.length - 1 ? cell.padEnd(widths[c] ?? 0) : cell;
          return colour ? colour(r, c, padded) : padded;
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function statusLabel(t: { status: TopicStatus | null; openThreadStatuses?: TopicStatus[] }) {
  if (t.status) return t.status;
  const open = t.openThreadStatuses ?? [];
  return open.length ? `(${[...new Set(open)].join("/")})` : "(none)";
}

export function topicTable(topics: TopicSummary[]): string {
  if (topics.length === 0) return "No topics.";
  const rows = topics.map((t) => [
    `${t.highlighted ? "*" : " "}${t.slug}`,
    statusLabel(t),
    when(t.lastWorkedAt),
    t.title,
  ]);
  return table(rows, (r, c, cell) => (c === 1 ? paint(cell, topics[r]?.status ?? null) : cell));
}

function indent(text: string, by = "    "): string {
  return text
    .split("\n")
    .map((l) => by + l)
    .join("\n");
}

export function entryText(e: Entry): string {
  const who = e.author + (e.threadId !== null ? ` (thread ${e.threadId})` : "");
  const lines = [`#${e.id}  ${when(e.at)}  ${e.kind}  ${who}`];
  if (e.body) lines.push(indent(e.body));
  const d = (e.data ?? {}) as Record<string, unknown>;
  if (typeof d.why === "string") lines.push(indent(`why: ${d.why}`));
  if (typeof d.result === "string") lines.push(indent(`result: ${d.result}`));
  if (Array.isArray(d.evidence)) for (const x of d.evidence) lines.push(indent(`evidence: ${x}`));
  if (typeof d.scope === "string") {
    lines.push(indent(`scope: ${d.scope}${d.standing ? " (standing)" : ""}`));
  }
  for (const r of e.refs) lines.push(indent(`ref: ${r.type}:${r.value}`));
  if (e.correctsEntryId !== null) lines.push(indent(`corrects: #${e.correctsEntryId}`));
  return lines.join("\n");
}

function threadLine(t: Thread): string {
  const where = t.environmentId
    ? `${t.provider}:${t.environmentId}/${t.providerThreadId}`
    : `${t.provider}:${t.providerThreadId}`;
  const state = t.endedAt ? `ended${t.endReason ? ` (${t.endReason})` : ""}` : "open";
  return `  #${t.id} ${where}  ${paint(t.status, t.status)}${t.waitingOnOwner ? " (waiting on owner)" : ""}  ${state}${t.title ? `  ${t.title}` : ""}`;
}

export interface MonitorView {
  id: number;
  kind: string;
  state: string;
  target: string | null;
}

export function topicText(t: TopicDetail, monitors: MonitorView[], history: Entry[]): string {
  const out: string[] = [];
  out.push(`${t.slug}: ${t.title}`);
  out.push(
    `status:      ${paint(statusLabel(t), t.status)}${t.statusNote ? `  (${t.statusNote})` : ""}`,
  );
  if (t.goal) out.push(`goal:        ${t.goal}`);
  out.push(`last worked: ${when(t.lastWorkedAt)}   created: ${when(t.createdAt)}`);
  const flags = [t.muted && "muted", t.highlighted && "highlighted"].filter(Boolean);
  if (flags.length) out.push(`flags:       ${flags.join(", ")}`);
  if (t.tickets.length) out.push(`tickets:     ${t.tickets.map((x) => x.slug).join(", ")}`);
  if (t.epics.length) out.push(`epics:       ${t.epics.map((x) => x.slug).join(", ")}`);
  out.push("", "Threads");
  out.push(...(t.threads.length ? t.threads.map(threadLine) : ["  (none)"]));
  out.push("", "Links");
  out.push(
    ...(t.links.length
      ? t.links.map((l) => `  #${l.id} ${l.kind}  ${l.target}${l.label ? `  (${l.label})` : ""}`)
      : ["  (none)"]),
  );
  out.push("", "Monitor targets");
  out.push(
    ...(monitors.length
      ? monitors.map((m) => `  #${m.id} ${m.kind}  ${m.state}${m.target ? `  ${m.target}` : ""}`)
      : ["  (none)"]),
  );
  out.push("", `History (last ${history.length})`);
  out.push(...(history.length ? history.map(entryText) : ["  (none)"]));
  return out.join("\n");
}
