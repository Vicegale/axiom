import type { ReactNode } from "react";
import { ApiError } from "../../api";
import { TopicDetail, type TopicDetailActions } from "../../components";
import { useActions } from "../../data/useActions";
import { type TopicBundle, useTopicDetail } from "../../data/useTopicDetail";

/** The owner's actions on one topic, wired to the API. */
export function useTopicActions(slug: string): TopicDetailActions {
  const actions = useActions();
  return {
    onToggleMute: (muted) => void actions.setMuted(slug, muted),
    onMarkStale: () => void actions.markStale(slug),
    onDismissStale: () => void actions.dismissStalePrompt(slug),
    onConfirmMonitor: (id) => void actions.confirmMonitor(id),
    onDeleteEntry: (id) => void actions.deleteEntry(id),
    onTaskStatus: (key, status) => void actions.setTaskStatus(slug, key, status),
  };
}

/** Loads a topic and renders `children` with it, or the loading / not-found / error text. */
export function TopicLoader({
  slug,
  emptyClass = "reader-empty",
  children,
}: {
  slug: string;
  emptyClass?: string;
  children: (bundle: TopicBundle) => ReactNode;
}) {
  const { data, error } = useTopicDetail(slug);
  if (error && !data) {
    return (
      <p className={emptyClass} role="alert">
        {error instanceof ApiError && error.status === 404
          ? `No topic called "${slug}".`
          : `Could not load the topic: ${error.message}`}
      </p>
    );
  }
  if (!data) return <p className={emptyClass}>Loading.</p>;
  return <>{children(data)}</>;
}

/** Which parts of TopicDetail a tab shows; the rest are hidden (see styles/topic-tabs.css). */
export type DetailPart = "top" | "threads" | "tasks" | "graph" | "links" | "monitors" | "history";

/**
 * The shared TopicDetail with only some of its parts visible. A tab in the Board sheet or the
 * Console panel is the same component showing a different slice, so there is no second copy of
 * threads, links, monitors or history rendering to drift. The stale prompt always shows.
 */
export function TopicSlice({
  bundle,
  show,
  now,
  withHistory = true,
  onPickTask,
}: {
  bundle: TopicBundle;
  show: readonly DetailPart[];
  now: Date;
  /** False when the caller renders the history itself, so it is not rendered twice. */
  withHistory?: boolean;
  /** A graph node was picked: the Board sheet and Console panel switch to the Tasks tab. */
  onPickTask?: (key: string) => void;
}) {
  const actions = useTopicActions(bundle.topic.slug);
  return (
    <div className="tt" data-show={show.join(" ")}>
      <TopicDetail
        topic={bundle.topic}
        entries={withHistory ? bundle.entries : undefined}
        tasks={bundle.tasks}
        hideEmptyTasks={false}
        onPickTask={onPickTask}
        ticketEpics={bundle.ticketEpics}
        now={now}
        actions={actions}
      />
    </div>
  );
}
