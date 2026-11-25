import { Link } from "wouter";
import { TopicDetail } from "../../components";
import { TopicLoader, useTopicActions } from "../shared/TopicPane";

interface Props {
  slug: string | undefined;
  now: Date;
  /** Where "Back to list" goes (shown only when the reader fills the window). */
  backHref: string;
}

/** The right-hand reading pane: the selected topic, or a hint. */
export function Reader({ slug, now, backHref }: Props) {
  return (
    <main
      className="reader"
      id={slug ? "main" : undefined}
      aria-label="Selected topic"
      tabIndex={-1}
    >
      {slug ? (
        <Link href={backHref} className="back-link">
          <span aria-hidden="true">←</span> Back to list
        </Link>
      ) : null}
      {slug ? (
        <TopicLoader slug={slug}>
          {({ topic, entries, tasks, ticketEpics }) => (
            <div className="r-scroll">
              <Detail
                topic={topic}
                entries={entries}
                tasks={tasks}
                ticketEpics={ticketEpics}
                now={now}
              />
            </div>
          )}
        </TopicLoader>
      ) : (
        <p className="reader-empty">Select a topic to read it.</p>
      )}
    </main>
  );
}

function Detail(props: Omit<React.ComponentProps<typeof TopicDetail>, "actions">) {
  const actions = useTopicActions(props.topic.slug);
  return <TopicDetail {...props} actions={actions} />;
}
