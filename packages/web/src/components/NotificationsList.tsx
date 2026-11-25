import { Link } from "wouter";
import type { AxiomNotification } from "../api";
import { NOTIF_STATUS } from "../lib/domain";
import { stamp } from "../lib/time";

interface Props {
  notifications: readonly AxiomNotification[];
  /** Resolves a topic title; falls back to the slug. */
  titleOf?: (slug: string) => string | undefined;
  hiddenCount?: number;
  now?: Date;
  /** A plain click on the topic link: marks the topic opened (which dismisses its notifications).
   *  The link itself navigates, so ctrl-click and middle-click open a tab without calling this. */
  onOpen: (slug: string) => void;
}

/** Just the list; the settings live on the settings page. */
export function NotificationsList({ notifications, titleOf, hiddenCount = 0, now, onOpen }: Props) {
  const at = now ?? new Date();
  return (
    <div className="np">
      {notifications.length ? (
        <ol className="notifs">
          {notifications.map((n) => (
            <li key={n.id} className={`notif s-${NOTIF_STATUS[n.kind] ?? "idle"}`}>
              <div className="n-head">
                <span className="n-kind">{n.kind}</span>
                <time dateTime={n.createdAt}>{stamp(n.createdAt, at)}</time>
              </div>
              <Link
                href={`/topic/${encodeURIComponent(n.topicSlug)}`}
                className="n-topic"
                onClick={() => onOpen(n.topicSlug)}
              >
                {titleOf?.(n.topicSlug) ?? n.topicSlug}
              </Link>
              {n.body ? <p className="n-body">{n.body}</p> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty">No notifications right now.</p>
      )}
      {hiddenCount > 0 ? <p className="hint">{hiddenCount} hidden by your mutes.</p> : null}
    </div>
  );
}
