import { Link } from "wouter";
import { Lock } from "../../components";
import type { TreeNode } from "../../lib/tree";
import { hrefs } from "../shared/routes";
import { Glyph } from "./Glyph";

interface Props {
  nodes: readonly TreeNode[];
  selected: string | undefined;
  onOpen: (slug: string) => void;
}

/** Epics, then tickets, then topics; Jira-owned epics and tickets show their key, Jira status
 *  and a lock. */
export function Tree({ nodes, selected, onOpen }: Props) {
  return (
    <ul className="cs-tree-list">
      {nodes.map((n) => {
        if (n.type === "unfiled-head") {
          return (
            <li key={n.key} className="cs-unfiled-h">
              Unfiled
            </li>
          );
        }
        const style = { "--d": n.depth } as React.CSSProperties;
        if (n.type === "topic") {
          const t = n.topic;
          return (
            <li key={n.key} className="cs-lvl" style={style}>
              <Link
                href={hrefs.topic(t.slug)}
                className="cs-node"
                aria-current={selected === t.slug ? "true" : undefined}
                onClick={() => onOpen(t.slug)}
              >
                <Glyph status={t.status} />
                <span className="cs-lbl">{t.slug}</span>
                {t.highlighted ? <i className="cs-udot" title="Unread" /> : null}
              </Link>
            </li>
          );
        }
        const it = n.item;
        return (
          <li key={n.key} className="cs-lvl" style={style}>
            <div className={`cs-node cs-kind-${n.type}`} data-kind={n.type}>
              <span className="cs-glyph cs-dim" aria-hidden="true">
                {n.type === "epic" ? "◆" : "▪"}
              </span>
              <span className="cs-lbl">{it.title}</span>
              <span className="cs-tail">
                {it.jiraKey ? (
                  <>
                    <span className="cs-jk">{it.jiraKey}</span> {it.jiraStatus ?? ""}
                    {it.locked ? <Lock /> : null}
                  </>
                ) : (
                  it.status
                )}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
