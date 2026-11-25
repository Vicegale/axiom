import { useEffect, useRef, useState } from "react";
import { useAxiom } from "../data/DataProvider";
import { inView } from "../lib/topics";

/**
 * A polite live region for what arrives over SSE: a new notification, or a topic that now needs
 * the owner. The first load only seeds what is already known. It never moves focus.
 */
export function LiveAnnouncer() {
  const { notifications, topics } = useAxiom();
  const seenNotes = useRef<Set<number> | null>(null);
  const seenAttention = useRef<Set<string>>(new Set());
  const [text, setText] = useState("");

  useEffect(() => {
    if (!notifications || !topics) return;
    const title = (slug: string) => topics.find((t) => t.slug === slug)?.title ?? slug;
    const attention = new Set(topics.filter((t) => inView(t, "attention")).map((t) => t.slug));
    const known = seenNotes.current;
    seenNotes.current = new Set(notifications.map((n) => n.id));
    const before = seenAttention.current;
    seenAttention.current = attention;
    if (known === null) return;

    const messages: string[] = [];
    const told = new Set<string>();
    for (const n of notifications) {
      if (known.has(n.id)) continue;
      told.add(n.topicSlug);
      messages.push(`${n.kind}: ${title(n.topicSlug)}${n.body ? `. ${n.body}` : ""}`);
    }
    for (const slug of attention) {
      if (!before.has(slug) && !told.has(slug)) messages.push(`${title(slug)} needs you`);
    }
    if (messages.length) setText(messages.join(". "));
  }, [notifications, topics]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
