import { Router } from "wouter";
import { DataProvider } from "./data/DataProvider";
import { InboxShell } from "./layouts/inbox/InboxShell";

/** Layouts: only Inbox exists so far; Board and Console arrive in S5b and pick up here. */
export function App({ router }: { router?: Partial<React.ComponentProps<typeof Router>> }) {
  return (
    <DataProvider>
      <Router {...router}>
        <InboxShell />
      </Router>
    </DataProvider>
  );
}
