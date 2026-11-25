import type { EntryAuthor, EntryKind } from "../lib/domain";

const KIND_LABEL: Record<EntryKind, string> = {
  note: "NOTE",
  decision: "DECIDED",
  finding: "FOUND",
  verification: "CHECKED",
  "owner input": "YOU SAID",
  authorization: "YOU ALLOWED",
  "next steps": "NEXT",
  "status change": "STATUS",
  "topic created": "CREATED",
  "thread event": "THREAD",
  "git event": "GIT",
  "deploy event": "DEPLOY",
};

const KIND_CLASS: Record<EntryKind, string> = {
  note: "k-note",
  decision: "k-decision",
  finding: "k-finding",
  verification: "k-verification",
  "owner input": "k-owner",
  authorization: "k-authorization",
  "next steps": "k-next",
  "status change": "k-axiom",
  "topic created": "k-axiom",
  "thread event": "k-axiom",
  "git event": "k-axiom",
  "deploy event": "k-axiom",
};

const AUTHOR: Record<EntryAuthor, string> = {
  agent: "AGENT",
  owner: "YOU",
  axiom: "AXIOM",
  steward: "STEWARD",
};

/** "AGENT FOUND", "YOU SAID", "AXIOM STATUS": author plus kind, in caps. */
export function entryLabel(author: EntryAuthor, kind: EntryKind): string {
  const kl = KIND_LABEL[kind] ?? String(kind).toUpperCase();
  // Owner kinds already say "YOU" ("YOU SAID"), so don't repeat it.
  if (author === "owner" && kl.startsWith("YOU")) return kl;
  return `${AUTHOR[author] ?? String(author).toUpperCase()} ${kl}`;
}

export function kindClass(kind: EntryKind): string {
  return KIND_CLASS[kind] ?? "k-axiom";
}

export function KindLabel({ author, kind }: { author: EntryAuthor; kind: EntryKind }) {
  return <span className="e-label">{entryLabel(author, kind)}</span>;
}
