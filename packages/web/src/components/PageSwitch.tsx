import { Link, useRoute } from "wouter";
import { hrefs } from "../layouts/shared/routes";

/** The two experiences, Tracker and Desk, as one switch in every layout's header. */
export function PageSwitch() {
  const [onDesk] = useRoute("/desk");
  return (
    <nav className="page-switch" aria-label="Pages">
      <Link href={hrefs.all} aria-current={onDesk ? undefined : "page"}>
        Tracker
      </Link>
      <Link href={hrefs.desk} aria-current={onDesk ? "page" : undefined}>
        Desk
      </Link>
    </nav>
  );
}
