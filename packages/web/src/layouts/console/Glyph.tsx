import { STATUS_GLYPH, type TopicStatus } from "../../lib/domain";

/** A status as a glyph plus a screen-reader word; null (several threads) is a dash. */
export function Glyph({ status }: { status: TopicStatus | null | undefined }) {
  if (!status) {
    return (
      <span className="cs-glyph" title="Several threads: each has its own status">
        —<span className="sr-only">no single status</span>
      </span>
    );
  }
  return (
    <span className={`cs-glyph s-${status}`} title={status}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      <span className="sr-only">{status}</span>
    </span>
  );
}
