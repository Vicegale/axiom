import { useAxiom } from "../data/DataProvider";

/** The id of this page's build; tests and dev run without one. */
const PAGE_BUILD = typeof __AXIOM_BUILD__ === "string" ? __AXIOM_BUILD__ : null;

/**
 * The server serves the newest web build from disk, but its API is the code it started with. When
 * the two differ (main was rebuilt since the server started), say so instead of failing later with
 * "no such endpoint".
 */
export function UpdateBanner() {
  const { health } = useAxiom();
  const serverBuild = health?.server.webBuildId ?? null;
  if (!PAGE_BUILD || !serverBuild || serverBuild === PAGE_BUILD) return null;
  return (
    <div className="update-banner" role="status">
      Axiom was updated after the server started. Restart <code>axiom server</code> to use the new
      version; until then, new features may fail.
    </div>
  );
}
