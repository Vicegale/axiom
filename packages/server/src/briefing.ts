import type { Link, TaskDetail, TopicDetail } from "@axiom/core";

/** Open tasks listed in a briefing; the rest are counted. */
const MAX_TASKS = 8;

/**
 * The Axiom context put before the owner's first message in a thread Axiom starts (a new topic's
 * first thread, or "New thread" on the Desk), so the agent knows it is tracked and where. The
 * agent's Axiom skill is opt-in per project; this message is the owner opting in for this thread.
 * The owner's own text is recorded on its own (as owner input), without the briefing.
 */
export function briefing(topic: TopicDetail, tasks: readonly TaskDetail[], text: string): string {
  const lines = [
    "[Axiom] This thread is tracked in Axiom, the owner's work tracker. Use the `axiom` CLI as the `axiom` skill describes, even if this project's instructions don't mention Axiom.",
    `- Topic: \`${topic.slug}\`, "${topic.title}" (status: ${topic.status ?? "none"}). This thread is attached to it; \`axiom thread show\` confirms it (if it says otherwise, run \`axiom thread attach ${topic.slug}\`).`,
  ];
  if (topic.goal) lines.push(`- Goal: ${topic.goal}`);
  if (topic.statusNote) lines.push(`- Status note: ${topic.statusNote}`);

  const open = tasks.filter((t) => t.status !== "done");
  if (tasks.length === 0) {
    lines.push("- Tasks: none yet.");
  } else {
    lines.push(`- Tasks: ${tasks.length - open.length} of ${tasks.length} done.`);
    for (const t of open.slice(0, MAX_TASKS)) {
      lines.push(`  - ${t.key} (${t.status}${t.waiting ? ", waiting" : ""}): ${t.title}`);
    }
    if (open.length > MAX_TASKS) lines.push(`  - and ${open.length - MAX_TASKS} more open.`);
  }

  const where = topic.links.filter((l: Link) =>
    ["repository", "worktree", "branch", "pr", "spec"].includes(l.kind),
  );
  if (where.length > 0) {
    lines.push(`- Links: ${where.map((l) => `${l.kind} ${l.target}`).join("; ")}`);
  }

  lines.push(
    '- Read `axiom topic show` first. Record decisions and findings as you go, and before you stop follow the skill\'s "Before you finish" list (`axiom task status <key> done`, then `axiom topic status …`, for example `done` or `hitl`).',
    "",
    "Message from the owner:",
    "",
    text,
  );
  return lines.join("\n");
}
