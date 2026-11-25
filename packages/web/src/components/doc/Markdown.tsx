import type { Element } from "hast";
import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { Link } from "wouter";
import type { DocData } from "../../api";
import { hrefs } from "../../layouts/shared/routes";
import { dirname, hasScheme, isMarkdownPath, relativePath, resolvePath } from "../../lib/paths";
import { Mermaid } from "./Mermaid";

/** The default (GitHub-like) schema plus what the renderer itself produces: task-list classes and
 *  checkboxes, and `data-*` on footnote blocks. Slugs, heading anchors and highlight classes are
 *  added after sanitising, so the document cannot supply them. */
const schema = {
  ...defaultSchema,
  // Footnote ids and links already carry remark's `user-content-` prefix; clobbering would double
  // it. Ids the author wrote are removed first (see `stripAuthorIds`) so none can clobber.
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    ul: [...(defaultSchema.attributes?.ul ?? []), ["className", "contains-task-list"]],
    li: [...(defaultSchema.attributes?.li ?? []), ["className", "task-list-item"]],
    input: [...(defaultSchema.attributes?.input ?? []), "checked"],
  },
};

type HastNode = { type: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** Drops `id` from raw HTML in the document, keeping only the ids the Markdown renderer itself
 *  makes for footnotes (heading slugs are added later, after sanitising). */
function stripAuthorIds() {
  const walk = (node: HastNode) => {
    const id = node.properties?.id;
    if (typeof id === "string" && !/^(user-content-|footnote-label$)/.test(id)) {
      delete node.properties?.id;
    }
    for (const child of node.children ?? []) walk(child);
  };
  return walk;
}

const REMARK = [remarkGfm];
const REHYPE = [
  rehypeRaw,
  stripAuthorIds,
  [rehypeSanitize, schema],
  rehypeSlug,
  [
    rehypeAutolinkHeadings,
    {
      behavior: "append",
      properties: { className: ["dv-anchor"], ariaLabel: "Link to this section" },
      content: { type: "text", value: "#" },
    },
  ],
  [rehypeHighlight, { detect: false, ignoreMissing: true, plainText: ["mermaid"] }],
] as NonNullable<React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>;

/** Scrolls to an element of the document and moves focus there (anchors, footnotes, the TOC). */
export function jumpTo(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: "start" });
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

function langOf(node: Element | undefined): string | null {
  const code = node?.children.find(
    (c): c is Element => c.type === "element" && c.tagName === "code",
  );
  const cls = code?.properties?.className;
  const list = Array.isArray(cls) ? cls.map(String) : [];
  return list.find((c) => c.startsWith("language-"))?.slice(9) ?? null;
}

function textOf(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

function Heading({
  n,
  node: _n,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { n: number; node?: unknown }) {
  // The viewer's own title is the page's heading; the document's levels sit one below it.
  const Tag = `h${Math.min(n + 1, 6)}` as "h2";
  return (
    <Tag {...props} data-level={n}>
      {children}
    </Tag>
  );
}

function makeComponents(doc: DocData, slug: string, theme: "dark" | "light"): Components {
  return {
    h1: (p) => <Heading n={1} {...p} />,
    h2: (p) => <Heading n={2} {...p} />,
    h3: (p) => <Heading n={3} {...p} />,
    h4: (p) => <Heading n={4} {...p} />,
    h5: (p) => <Heading n={5} {...p} />,
    h6: (p) => <Heading n={6} {...p} />,
    a({ node: _n, href, children, ...props }) {
      if (!href) return <a {...props}>{children}</a>;
      if (href.startsWith("#")) {
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              jumpTo(decodeURIComponent(href.slice(1)));
            }}
          >
            {children}
          </a>
        );
      }
      if (hasScheme(href)) {
        const web = /^https?:/i.test(href);
        return (
          <a {...props} href={href} target={web ? "_blank" : undefined} rel="noreferrer">
            {children}
          </a>
        );
      }
      const hashAt = href.indexOf("#");
      const file = hashAt === -1 ? href : href.slice(0, hashAt);
      const hash = hashAt === -1 ? "" : href.slice(hashAt);
      if (file && isMarkdownPath(file)) {
        let rel = file;
        try {
          rel = decodeURI(file);
        } catch {}
        const target = rel.startsWith("/")
          ? resolvePath(doc.root, rel.slice(1))
          : resolvePath(dirname(doc.path), rel);
        return (
          <Link href={`${hrefs.doc(slug, doc.linkId, relativePath(doc.baseDir, target))}${hash}`}>
            {children}
          </Link>
        );
      }
      // A relative link to something the viewer cannot show (source code, a directory).
      return (
        <span className="dv-nolink" title={`${href} (not shown in the viewer)`}>
          {children}
        </span>
      );
    },
    img({ node: _n, src, alt, ...props }) {
      let url = typeof src === "string" ? src : "";
      if (url && !hasScheme(url)) {
        let rel = url.split(/[?#]/)[0] ?? url;
        try {
          rel = decodeURI(rel);
        } catch {}
        const abs = rel.startsWith("/")
          ? resolvePath(doc.root, rel.slice(1))
          : resolvePath(dirname(doc.path), rel);
        url = `/api/topics/${encodeURIComponent(slug)}/files?path=${encodeURIComponent(abs)}`;
      }
      return <img {...props} src={url} alt={alt ?? ""} loading="lazy" />;
    },
    input({ node: _n, ...props }) {
      return props.type === "checkbox" ? (
        <input {...props} aria-label={props.checked ? "Done" : "Not done"} />
      ) : (
        <input {...props} />
      );
    },
    table({ node: _n, children, ...props }) {
      return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
        <section className="dv-table" aria-label="Table" tabIndex={0}>
          <table {...props}>{children}</table>
        </section>
      );
    },
    pre({ node, children, ...props }) {
      if (langOf(node) === "mermaid") return <>{children}</>;
      return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
        <pre {...props} tabIndex={0}>
          {children}
        </pre>
      );
    },
    code({ node: _n, className, children, ...props }) {
      if (className?.split(" ").includes("language-mermaid")) {
        return <Mermaid source={textOf(children).replace(/\n$/, "")} theme={theme} />;
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };
}

interface Props {
  doc: DocData;
  slug: string;
  theme: "dark" | "light";
}

/** The sanitised, highlighted rendering of one document. Memoised: the viewer polls, and only a
 *  changed file (or theme) redraws it. */
export const Markdown = memo(function Markdown({ doc, slug, theme }: Props) {
  const components = useMemo(() => makeComponents(doc, slug, theme), [doc, slug, theme]);
  return (
    <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
      {doc.markdown}
    </ReactMarkdown>
  );
});
