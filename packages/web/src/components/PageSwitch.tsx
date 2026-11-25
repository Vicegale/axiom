import { Link, useRoute } from "wouter";
import { useAxiom } from "../data/DataProvider";
import { hrefs } from "../layouts/shared/routes";
import { Facet } from "./Icons";

/** The experiences, Tracker, Desk and Steward, as one switch in every layout's header. */
export function PageSwitch() {
  const [onDesk] = useRoute("/desk");
  const [onSteward] = useRoute("/steward");
  const { stewardCount } = useAxiom();
  return (
    <nav className="page-switch" aria-label="Pages">
      <Link href={hrefs.all} aria-current={onDesk || onSteward ? undefined : "page"}>
        Tracker
      </Link>
      <Link href={hrefs.desk} aria-current={onDesk ? "page" : undefined}>
        Desk
      </Link>
      <Link
        href={hrefs.steward}
        className="ps-steward"
        aria-current={onSteward ? "page" : undefined}
        aria-label={stewardCount ? `Steward, ${stewardCount} need you` : "Steward"}
      >
        <span className="ps-ic">
          <Facet size={13} />
        </span>
        <span className="ps-label">Steward</span>
        {stewardCount ? (
          <b className="ps-count" aria-hidden="true">
            {stewardCount}
          </b>
        ) : null}
      </Link>
    </nav>
  );
}
