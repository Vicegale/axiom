import { TopicDetail } from "../../components";
import { TopicLoader, useTopicActions } from "../shared/TopicPane";

interface Props {
  slug: string | undefined;
  now: Date;
}

/** The right-hand reading pane: the selected topic, or a hint. */
export function Reader({ slug, now }: Props) {
  return (
    <main className="reader" aria-label="Selected topic" tabIndex={-1}>
      {slug ? (
        <TopicLoader slug={slug}>
          {({ topic, entries, ticketEpics }) => (
            <div className="r-scroll">
              <Detail topic={topic} entries={entries} ticketEpics={ticketEpics} now={now} />
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
