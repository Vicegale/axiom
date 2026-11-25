import { ApiError, type AxiomNotification } from "../../api";
import { TopicDetail } from "../../components";
import { useActions } from "../../data/useActions";
import { useTopicDetail } from "../../data/useTopicDetail";
import { attentionOf } from "../../lib/topics";

interface Props {
  slug: string | undefined;
  notifications: readonly AxiomNotification[];
  now: Date;
}

/** The right-hand reading pane: the selected topic, or a hint. */
export function Reader({ slug, notifications, now }: Props) {
  const actions = useActions();
  const { data, error } = useTopicDetail(slug);

  let body: React.ReactNode;
  if (!slug) {
    body = <p className="reader-empty">Select a topic to read it.</p>;
  } else if (error && !data) {
    body = (
      <p className="reader-empty" role="alert">
        {error instanceof ApiError && error.status === 404
          ? `No topic called "${slug}".`
          : `Could not load the topic: ${error.message}`}
      </p>
    );
  } else if (!data) {
    body = <p className="reader-empty">Loading.</p>;
  } else {
    const { topic, entries, ticketEpics } = data;
    body = (
      <div className="r-scroll">
        <TopicDetail
          topic={topic}
          entries={entries}
          ticketEpics={ticketEpics}
          now={now}
          attention={attentionOf(
            {
              slug: topic.slug,
              status: topic.status,
              threads: topic.threads.map((t) => ({
                id: t.id,
                provider: t.provider,
                title: t.title,
                status: t.status,
                open: t.endedAt === null,
              })),
            },
            notifications,
            entries,
          )}
          actions={{
            onToggleMute: (muted) => void actions.setMuted(topic.slug, muted),
            onMarkStale: () => void actions.markStale(topic.slug),
            onDismissStale: () => void actions.dismissStalePrompt(topic.slug),
            onConfirmMonitor: (id) => void actions.confirmMonitor(id),
            onDeleteEntry: (id) => void actions.deleteEntry(id),
          }}
        />
      </div>
    );
  }
  return (
    <main className="reader" aria-label="Selected topic" tabIndex={-1}>
      {body}
    </main>
  );
}
