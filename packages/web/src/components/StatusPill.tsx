import type { TopicStatus } from "../lib/domain";

/** A status as a coloured pill; null (several running threads) is a dashed dash. */
export function StatusPill({ status }: { status: TopicStatus | null | undefined }) {
  if (!status) {
    return (
      <span className="pill none" title="More than one thread: each thread has its own status">
        —
      </span>
    );
  }
  return <span className={`pill s-${status}`}>{status}</span>;
}
