import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import type { DocData } from "../../api";
import { resetWideForTests } from "../../lib/wide";
import { expectAccessible } from "../../test/axe";
import { FakeServer, topic } from "../../test/fakeApi";
import { POLL_MS } from "./DocViewer";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

const MD = `# Plan title

Intro with a [relative link](../adr/0001.md#why), an [anchor](#details),
an [external](https://example.com/x), and [source](../src/a.ts).

## Details

| Name | Value |
| ---- | ----- |
| one  | 1     |
| two  | 2     |

- [x] done item
- [ ] open item

~~gone~~ and https://auto.example.com/link

\`\`\`ts
const answer: number = 42;
\`\`\`

![diagram](img/pic.png)

### Sub section

Footnote here[^1].

[^1]: The note.

<script>alert(1)</script>
<img src="x" onerror="alert(2)">
<a id="clobber">x</a>
`;

function doc(over: Partial<DocData> = {}): DocData {
  return {
    linkId: 7,
    path: "/repo/docs/plan/v1.md",
    relPath: "docs/plan/v1.md",
    root: "/repo",
    baseDir: "/repo/docs/plan",
    title: "Plan title",
    markdown: MD,
    mtime: 1,
    ...over,
  };
}

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  server.topics = [topic({ slug: "t", title: "The topic", status: "wip" })];
  server.details.set("t", {
    links: [
      { id: 7, kind: "spec", target: "docs/plan/v1.md", label: null },
      { id: 8, kind: "artifact", target: "/tmp/notes.md", label: "Notes" },
      { id: 9, kind: "artifact", target: "/tmp/shot.png", label: null },
      { id: 10, kind: "spec", target: "https://example.com/spec", label: null },
      { id: 11, kind: "repository", target: "/repo", label: null },
    ],
  });
  server.docs.set("t:7", doc());
  server.docs.set("t:7:../adr/0001.md", doc({ path: "/repo/docs/adr/0001.md", title: "ADR 1" }));
  server.install();
  localStorage.clear();
  resetWideForTests();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  document.documentElement.setAttribute("data-theme", "dark");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function open(path = "/topic/t/doc/7", layout: "inbox" | "board" | "console" = "inbox") {
  server.settings.layout = layout;
  const loc = memoryLocation({ path, record: true });
  render(<App router={{ hook: loc.hook, searchHook: loc.searchHook }} />);
  return loc;
}

const article = async () => (await screen.findByRole("article")) as HTMLElement;

describe("rendering", () => {
  it("renders GFM tables, task lists, strikethrough, autolinks and footnotes", async () => {
    open();
    const a = await article();
    const table = within(a).getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Name", "Value"]);
    expect(within(table).getAllByRole("cell")).toHaveLength(4);
    // Tables scroll inside their own focusable box.
    expect(table.parentElement?.className).toBe("dv-table");
    const boxes = within(a).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(a.querySelector("del")?.textContent).toBe("gone");
    expect(within(a).getByRole("link", { name: "https://auto.example.com/link" })).toBeTruthy();
    expect(a.querySelector("[data-footnotes]")?.textContent).toContain("The note.");
    // The reference points at a note that exists (sanitising must not break the ids).
    const ref = a.querySelector("a[data-footnote-ref]") as HTMLAnchorElement;
    expect(a.querySelector(`[id="${ref.getAttribute("href")?.slice(1)}"]`)).toBeTruthy();
  });

  it("highlights code with the mono block and no language guessing", async () => {
    open();
    const a = await article();
    const code = a.querySelector("pre code.language-ts") as HTMLElement;
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(code.querySelector(".hljs-number")?.textContent).toBe("42");
  });

  it("sanitises raw HTML", async () => {
    open();
    const a = await article();
    expect(a.querySelector("script")).toBeNull();
    expect(a.innerHTML).not.toContain("onerror");
    expect(a.innerHTML).not.toContain("alert(");
    expect(document.getElementById("clobber")).toBeNull();
  });

  it("gives headings anchors and builds the table of contents from h2 and h3", async () => {
    open();
    const a = await article();
    // The page's title is the h1; the document's levels sit one below.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(a.querySelector("h2[data-level='1']")?.textContent).toContain("Plan title");
    const details = a.querySelector("h3[data-level='2']") as HTMLElement;
    expect(details.id).toBe("details");
    const anchor = details.querySelector("a.dv-anchor") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("#details");
    const toc = await screen.findByRole("navigation", { name: "Table of contents" });
    expect(
      within(toc)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Details", "Sub section"]);
  });

  it("scrolls #anchor links instead of navigating, and opens external links in a new tab", async () => {
    const loc = open();
    const a = await article();
    const target = a.querySelector("#details") as HTMLElement;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    fireEvent.click(within(a).getByRole("link", { name: "anchor" }));
    expect(scroll).toHaveBeenCalled();
    expect(loc.history?.at(-1)).toBe("/topic/t/doc/7");
    const ext = within(a).getByRole("link", { name: "external" });
    expect(ext.getAttribute("target")).toBe("_blank");
    expect(ext.getAttribute("rel")).toBe("noreferrer");
  });

  it("opens a relative .md link in the viewer with ?path=", async () => {
    const loc = open();
    const a = await article();
    const link = within(a).getByRole("link", { name: "relative link" });
    expect(link.getAttribute("href")).toBe("/topic/t/doc/7?path=..%2Fadr%2F0001.md#why");
    fireEvent.click(link);
    await screen.findByRole("heading", { level: 1, name: "ADR 1" });
    expect(loc.history?.at(-1)).toBe("/topic/t/doc/7?path=..%2Fadr%2F0001.md#why");
    expect(server.called("GET", "/api/topics/t/docs/7?path=..%2Fadr%2F0001.md")).toHaveLength(1);
  });

  it("does not link relative paths it cannot show", async () => {
    open();
    const a = await article();
    expect(within(a).queryByRole("link", { name: "source" })).toBeNull();
    expect(within(a).getByText("source").getAttribute("title")).toContain("not shown");
  });

  it("serves relative images through the files endpoint", async () => {
    open();
    const a = await article();
    const img = within(a).getByRole("img", { name: "diagram" });
    expect(img.getAttribute("src")).toBe(
      `/api/topics/t/files?path=${encodeURIComponent("/repo/docs/plan/img/pic.png")}`,
    );
  });

  it("is accessible", async () => {
    open();
    await article();
    await expectAccessible();
  });
});

describe("mermaid", () => {
  const withDiagram = (src: string) =>
    server.docs.set("t:7", doc({ markdown: `# D\n\n\`\`\`mermaid\n${src}\n\`\`\`\n` }));

  it("renders a mermaid block through mermaid in strict mode, with the theme", async () => {
    withDiagram("graph TD; A-->B");
    mermaid.render.mockResolvedValue({ svg: '<svg data-testid="svg"></svg>' });
    open();
    await waitFor(() => expect(document.querySelector("[data-testid='svg']")).toBeTruthy());
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", theme: "dark", startOnLoad: false }),
    );
    expect(mermaid.render.mock.calls[0]?.[1]).toBe("graph TD; A-->B");
    expect(screen.getByText("Diagram source")).toBeTruthy();

    // A theme change draws it again with the other theme.
    act(() => document.documentElement.setAttribute("data-theme", "light"));
    await waitFor(() =>
      expect(mermaid.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "default" }),
      ),
    );
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("shows the error and the source when a diagram does not parse", async () => {
    withDiagram("graph TD; A--");
    mermaid.render.mockRejectedValue(new Error("Parse error on line 1"));
    open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be drawn");
    expect(alert.textContent).toContain("Parse error on line 1");
    expect(document.querySelector(".dv-mermaid-error pre")?.textContent).toContain("graph TD; A--");
    // The rest of the page still renders.
    expect(screen.getByRole("article")).toBeTruthy();
  });

  it("never loads mermaid for a document without a diagram", async () => {
    open();
    await article();
    expect(mermaid.initialize).not.toHaveBeenCalled();
  });
});

describe("chrome", () => {
  it("has a back control to the topic and sets the page title", async () => {
    const loc = open();
    await article();
    await waitFor(() => expect(document.title).toBe("Plan title · The topic · Axiom"));
    fireEvent.click(screen.getByRole("link", { name: /Back to topic/ }));
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/t"));
  });

  it("shows the file's path under the title", async () => {
    open();
    await article();
    expect(screen.getByText("docs/plan/v1.md")).toBeTruthy();
  });

  it("shows a message when the file is gone", async () => {
    server.docs.clear();
    open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no longer exists");
  });

  it("remembers the Wide toggle per browser and collapses the lists", async () => {
    open();
    await article();
    const wide = screen.getByRole("button", { name: "Wide" });
    expect(wide.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".app")?.hasAttribute("data-wide")).toBe(false);
    fireEvent.click(wide);
    expect(wide.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("axiom.doc.wide")).toBe("1");
    expect(document.querySelector(".app")?.getAttribute("data-wide")).toBe("true");
    expect(document.querySelector(".rail")?.hasAttribute("hidden")).toBe(true);
  });

  it("starts wide when the browser remembers it", async () => {
    localStorage.setItem("axiom.doc.wide", "1");
    open();
    await article();
    expect(screen.getByRole("button", { name: "Wide" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("re-reads the file when its mtime changes, and leaves it alone otherwise", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open();
    const a = await article();
    const calls = () => server.called("GET", "/api/topics/t/docs/7").length;
    const before = calls();
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(calls()).toBeGreaterThan(before);
    const same = a.querySelector("h3");
    expect(same?.textContent).toContain("Details");

    server.docs.set("t:7", doc({ mtime: 2, markdown: `${MD}\n## Added later\n` }));
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    await waitFor(() => expect(screen.getAllByText("Added later").length).toBeGreaterThan(0));
  });
});

describe("layouts", () => {
  it("opens in the Inbox reader", async () => {
    open("/topic/t/doc/7", "inbox");
    await article();
    expect(document.querySelector("main.reader .dv")).toBeTruthy();
  });

  it("opens in the Board sheet, and wide fills the window", async () => {
    open("/topic/t/doc/7", "board");
    await screen.findByRole("button", { name: "Wide" });
    await article();
    const sheet = screen.getByRole("dialog", { name: "Document" });
    expect(sheet.querySelector(".dv")).toBeTruthy();
    expect(sheet.hasAttribute("data-wide")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Wide" }));
    expect(sheet.getAttribute("data-wide")).toBe("true");
  });

  it("closing the Board sheet leaves the document", async () => {
    const loc = open("/topic/t/doc/7", "board");
    await article();
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/"));
  });

  it("opens in the Console panel, and wide hides the sidebar and table", async () => {
    open("/topic/t/doc/7", "console");
    await article();
    expect(document.querySelector(".cs-panel .dv")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wide" }));
    expect(document.querySelector(".cs-app")?.getAttribute("data-wide")).toBe("true");
    expect(document.querySelector(".cs-side")?.hasAttribute("hidden")).toBe(true);
  });
});

describe("Links row", () => {
  it("links spec and Markdown artifact chips to the viewer, nothing else", async () => {
    open("/topic/t");
    const spec = await screen.findByRole("link", { name: "docs/plan/v1.md" });
    expect(spec.getAttribute("href")).toBe("/topic/t/doc/7");
    expect(spec.hasAttribute("target")).toBe(false);
    expect(screen.getByRole("link", { name: "Notes" }).getAttribute("href")).toBe("/topic/t/doc/8");
    // A PNG artifact opens in the viewer too; a spec on the web stays a web link.
    expect(screen.getByRole("link", { name: "/tmp/shot.png" }).getAttribute("href")).toBe(
      "/topic/t/doc/9",
    );
    const web = screen.getByRole("link", { name: "https://example.com/spec" });
    expect(web.getAttribute("target")).toBe("_blank");
  });

  it("a plain click opens the viewer in the same tab", async () => {
    const loc = open("/topic/t");
    fireEvent.click(await screen.findByRole("link", { name: "docs/plan/v1.md" }));
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/t/doc/7"));
    await article();
  });

  it("a modified click is left to the browser", async () => {
    const loc = open("/topic/t");
    fireEvent.click(await screen.findByRole("link", { name: "docs/plan/v1.md" }), {
      ctrlKey: true,
    });
    expect(loc.history?.at(-1)).toBe("/topic/t");
  });
});
