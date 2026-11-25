import { Link } from "wouter";
import { TopicDetail } from "../../components";
import { LazyDocViewer } from "../../components/doc/LazyDocViewer";
import { TopicLoader, useTopicActions } from "../shared/TopicPane";

interface Props {
  slug: string | undefined;
  now: Date;
  /** Where "Back to list" goes (shown only when the reader fills the window). */
  backHref: string;
  /** A document is open in place of the topic. */
  doc?: { linkId: number; path: string | undefined };
}

/** The right-hand reading pane: the selected topic, or a hint. */
export function Reader({ slug, now, backHref, doc }: Props) {
  return (
    <main
      className="reader"
      id={slug ? "main" : undefined}
      aria-label={doc ? "Document" : "Selected topic"}
      tabIndex={-1}
    >
      {slug ? (
        <Link href={backHref} className="back-link">
          <span aria-hidden="true">←</span> Back to list
        </Link>
      ) : null}
      {slug && doc ? (
        <LazyDocViewer slug={slug} linkId={doc.linkId} path={doc.path} level={1} />
      ) : slug ? (
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
