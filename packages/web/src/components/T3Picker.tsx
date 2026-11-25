import { useEffect, useId, useRef, useState } from "react";
import { api, type T3Thread } from "../api";
import { ago } from "../lib/time";
import "../styles/picker.css";

interface Props {
  /** The topic the chosen thread is attached to. */
  slug: string;
  now?: Date;
}

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

/**
 * "Attach T3 thread": a small picker of T3 threads not yet attached to any topic, filtered by
 * title. Choosing one posts it to the topic; the page refreshes on the server's change event.
 */
export function T3Picker({ slug, now }: Props) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<T3Thread[]>([]);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ kind: "loading" });
    setFailure(null);
    api
      .t3Threads()
      .then((list) => {
        if (!live) return;
        setThreads(list);
        setLoad({ kind: "ready" });
      })
      .catch((e: unknown) => {
        if (live) {
          setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    search.current?.focus();
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const at = now ?? new Date();
  const q = query.trim().toLowerCase();
  const shown = q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;

  async function attach(t: T3Thread) {
    setBusy(t.id);
    setFailure(null);
    try {
      await api.attachThread(slug, {
        provider: "t3",
        providerThreadId: t.id,
        ...(t.environmentId ? { environmentId: t.environmentId } : {}),
        title: t.title,
      });
      setThreads((list) => list.filter((x) => x.id !== t.id));
      setOpen(false);
      toggle.current?.focus();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the popup from any child
    <div
      className="picker-wrap"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <button
        type="button"
        className="btn"
        ref={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        Attach T3 thread
      </button>
      {open ? (
        <div className="picker" id={id} role="dialog" aria-label="Attach a T3 thread">
          <p className="picker-h">Unattached T3 threads</p>
          <input
            ref={search}
            className="picker-search"
            type="search"
            placeholder="Search by title"
            aria-label="Search T3 threads"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {failure ? (
            <p className="picker-error" role="alert">
              {failure}
            </p>
          ) : null}
          {load.kind === "loading" ? <p className="picker-empty">Loading T3 threads.</p> : null}
          {load.kind === "error" ? (
            <p className="picker-error" role="alert">
              {load.message}
            </p>
          ) : null}
          {load.kind === "ready" && threads.length === 0 ? (
            <p className="picker-empty">Every T3 thread is attached.</p>
          ) : null}
          {load.kind === "ready" && threads.length > 0 && shown.length === 0 ? (
            <p className="picker-empty">No threads match.</p>
          ) : null}
          {load.kind === "ready" && shown.length > 0 ? (
            <ul>
              {shown.map((t) => (
                <li key={t.id}>
                  <div>
                    <span className="picker-t">{t.title}</span>
                    <span className="picker-sub">
                      <span>{t.id}</span>
                      {t.environmentId ? <span>{t.environmentId}</span> : null}
                      <span>{t.status}</span>
                      <span>updated {ago(t.updatedAt, at)}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy !== null}
                    aria-label={`Attach ${t.title}`}
                    onClick={() => void attach(t)}
                  >
                    Attach
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
