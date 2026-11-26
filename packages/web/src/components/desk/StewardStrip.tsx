import { useId, useState } from "react";
import { Link } from "wouter";
import type { DeskSteward } from "../../api";
import { hrefs } from "../../layouts/shared/routes";
import { Facet } from "../Icons";
import { DiffView, useDiff } from "../steward/StewardItems";

interface Props {
  steward: DeskSteward;
  /** Each returns whether it worked; a refusal reaches the banner. */
  onAdopt: (id: number) => Promise<boolean>;
  onDismiss: (id: number) => Promise<boolean>;
}

/**
 * The two lines on a card Steward has something for (mockup 8): the most important open item
 * with the Facet icon (and "Urgent" when it is), then one fitting action and a link to the
 * rest. A ready fix gets Adopt and Diff (the diff opens in the card), a question links to its
 * place on the Steward page, any other finding can be dismissed.
 */
export function StewardStrip({ steward: s, onAdopt, onDismiss }: Props) {
  const diffId = useId();
  const diff = useDiff(s.fix?.itemId ?? 0);
  const [busy, setBusy] = useState(false);
  const act = async (fn: (id: number) => Promise<boolean>, id: number) => {
    if (busy) return;
    setBusy(true);
    await fn(id);
    setBusy(false);
  };
  const where = `${hrefs.steward}#st-item-${s.itemId}`;
  return (
    <section className="dk-steward" aria-label="Steward">
      <p className="dk-st-t">
        <span className="dk-st-ic">
          <Facet size={14} />
        </span>
        {s.level === "urgent" ? <span className="st-lvl">Urgent</span> : null}
        <span className="dk-st-title" title={s.title}>
          {s.title}
          {s.fix ? " · a fix is ready" : ""}
        </span>
      </p>
      <div className="dk-st-acts">
        {s.fix ? (
          <>
            <button
              type="button"
              className="btn sm st-primary"
              disabled={busy}
              title={
                s.fix.kind === "rebase copy"
                  ? "Moves your branch to the rebased copy locally; the old tip is saved. Pushing stays yours."
                  : "Applies it to your branch locally. Pushing stays yours."
              }
              onClick={() => void act(onAdopt, s.fix?.itemId ?? 0)}
            >
              Adopt fix<span className="sr-only"> on {s.fix.branch}</span>
            </button>
            <button
              type="button"
              className="btn sm"
              aria-expanded={diff.open}
              aria-controls={diffId}
              onClick={diff.toggle}
            >
              Diff
            </button>
          </>
        ) : s.kind === "question" ? (
          <Link href={where} className="btn sm">
            Answer<span className="sr-only">: {s.title}</span>
          </Link>
        ) : (
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => void act(onDismiss, s.itemId)}
          >
            Dismiss<span className="sr-only">: {s.title}</span>
          </button>
        )}
        <Link href={s.more > 0 ? hrefs.steward : where} className="dk-st-more">
          {s.more > 0 ? `${s.more} more in Steward` : "Open in Steward"}
        </Link>
      </div>
      {s.fix ? <DiffView id={diffId} diff={diff} ready={diff.state !== null} /> : null}
    </section>
  );
}
