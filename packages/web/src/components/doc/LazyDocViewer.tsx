import { lazy, Suspense } from "react";

const DocViewer = lazy(() => import("./DocViewer"));

type Props = React.ComponentProps<typeof DocViewer>;

/** The viewer and its Markdown stack load as a separate chunk, only when a document is opened. */
export function LazyDocViewer(props: Props) {
  return (
    <Suspense fallback={<p className="dv-state">Loading.</p>}>
      <DocViewer {...props} />
    </Suspense>
  );
}
