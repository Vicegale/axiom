import { Router } from "wouter";
import { LiveAnnouncer } from "./components";
import { DataProvider, useAxiom } from "./data/DataProvider";
import { BoardShell } from "./layouts/board/BoardShell";
import { ConsoleShell } from "./layouts/console/ConsoleShell";
import { InboxShell } from "./layouts/inbox/InboxShell";

/** The layout the owner chose on the settings page. Every layout shares the routes, so switching
 *  keeps the open topic. */
function Layout() {
  const { settings, error } = useAxiom();
  // Wait for the setting rather than flashing Inbox first; if settings cannot load, use Inbox.
  if (!settings && !error) return <div className="boot" aria-busy="true" />;
  switch (settings?.layout) {
    case "board":
      return <BoardShell />;
    case "console":
      return <ConsoleShell />;
    default:
      return <InboxShell />;
  }
}

export function App({ router }: { router?: Partial<React.ComponentProps<typeof Router>> }) {
  return (
    <DataProvider>
      <Router {...router}>
        <Layout />
        <LiveAnnouncer />
      </Router>
    </DataProvider>
  );
}
