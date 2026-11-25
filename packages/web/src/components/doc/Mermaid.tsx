import { useEffect, useId, useState } from "react";

function panelColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--panel").trim() || "#111316";
}

type State = { svg: string } | { error: string } | null;

/**
 * One ```mermaid block. The `mermaid` package is loaded on first use (a dynamic import, so a
 * document without a diagram never downloads it) in strict security mode, and the diagram is
 * drawn again when the theme changes. A diagram that does not parse shows the error and its
 * source instead of breaking the page.
 */
export function Mermaid({ source, theme }: { source: string; theme: "dark" | "light" }) {
  const id = `mmd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // The previous drawing stays until the next one is ready, so the page does not jump.
  const [state, setState] = useState<State>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
          fontFamily: "inherit",
          // Labels on edges sit on the diagram box, whatever the theme's own grey is.
          themeVariables: { edgeLabelBackground: panelColor() },
        });
        const { svg } = await mermaid.render(id, source);
        if (live) setState({ svg });
      } catch (e) {
        // Mermaid leaves its scratch element in <body> when a diagram fails.
        document.getElementById(`d${id}`)?.remove();
        if (live) setState({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [source, theme, id]);

  if (state === null) {
    return (
      <p className="dv-mermaid-wait" aria-busy="true">
        Drawing diagram.
      </p>
    );
  }
  if ("error" in state) {
    return (
      <section className="dv-mermaid-error" aria-label="Diagram error">
        <p role="alert">
          <strong>This diagram could not be drawn.</strong> {state.error.split("\n")[0]}
        </p>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable */}
        <pre tabIndex={0}>
          <code>{source}</code>
        </pre>
      </section>
    );
  }
  return (
    <figure className="dv-mermaid">
      <div
        className="dv-mermaid-svg"
        role="img"
        aria-label="Diagram; the source is below"
        // Mermaid's strict mode sanitises the SVG it returns.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the SVG comes from mermaid (strict)
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
      <details className="dv-mermaid-src">
        <summary>Diagram source</summary>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable */}
        <pre tabIndex={0}>
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
