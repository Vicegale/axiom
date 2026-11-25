import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import type { ArtifactData } from "../../api";
import { resetWideForTests } from "../../lib/wide";
import { expectAccessible } from "../../test/axe";
import { FakeServer, topic } from "../../test/fakeApi";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

const html: ArtifactData = {
  linkId: 20,
  kind: "html",
  title: "Inbox mockup",
  path: "/repo/docs/inbox.html",
  relPath: "docs/inbox.html",
  mtime: 100,
  size: 10,
};
const image: ArtifactData = {
  linkId: 21,
  kind: "image",
  title: "Relay",
  path: "/repo/docs/relay.png",
  relPath: "docs/relay.png",
  mtime: 100,
  size: 10,
};

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  server.topics = [topic({ slug: "t", title: "The topic", status: "wip" })];
  server.details.set("t", {
    links: [
      { id: 20, kind: "artifact", target: "docs/inbox.html", label: "Inbox mockup" },
      { id: 21, kind: "artifact", target: "docs/relay.png", label: "Relay" },
      { id: 22, kind: "artifact", target: "docs/old.HTM", label: null },
      { id: 23, kind: "artifact", target: "https://example.com/x.html", label: null },
      { id: 24, kind: "artifact", target: "docs/app.js", label: null },
      { id: 25, kind: "repository", target: "/repo", label: null },
    ],
  });
  server.artifacts.set("t:20", html);
  server.artifacts.set("t:21", image);
  server.install();
  localStorage.clear();
  resetWideForTests();
  document.documentElement.setAttribute("data-theme", "dark");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function open(path: string, layout: "inbox" | "board" | "console" = "inbox") {
  server.settings.layout = layout;
  const loc = memoryLocation({ path, record: true });
  render(<App router={{ hook: loc.hook, searchHook: loc.searchHook }} />);
  return loc;
}

const frame = async () => (await screen.findByTitle("Inbox mockup")) as HTMLIFrameElement;

async function openMenu() {
  fireEvent.click(await screen.findByRole("button", { name: /^Artifacts · \d+/ }));
}
const item = (name: RegExp | string) => screen.getByRole("menuitem", { name });

describe("Links row", () => {
  it("lists local .html/.htm and image artifacts in the menu, linked to the viewer", async () => {
    open("/topic/t");
    await openMenu();
    expect(item(/Inbox mockup/).getAttribute("href")).toBe("/topic/t/doc/20");
    expect(item(/Relay/).getAttribute("href")).toBe("/topic/t/doc/21");
    expect(item(/old\.HTM/).getAttribute("href")).toBe("/topic/t/doc/22");
    // A web page stays a web link; a script is not viewable, so it has nowhere to go.
    expect(item(/example\.com\/x\.html/).getAttribute("target")).toBe("_blank");
    expect(item(/app\.js/).hasAttribute("href")).toBe(false);
  });

  it("a plain click opens the viewer in place; a modified click does not", async () => {
    const loc = open("/topic/t");
    await openMenu();
    fireEvent.click(item(/Inbox mockup/), { ctrlKey: true });
    expect(loc.history?.at(-1)).toBe("/topic/t");
    await openMenu();
    fireEvent.click(item(/Inbox mockup/));
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/t/doc/20"));
    await frame();
  });
});

describe("HTML artifact", () => {
  it("runs in a sandboxed iframe without allow-same-origin, with a title", async () => {
    open("/topic/t/doc/20");
    const f = await frame();
    const sandbox = f.getAttribute("sandbox") ?? "";
    expect(sandbox.split(" ").sort()).toEqual(
      ["allow-downloads", "allow-forms", "allow-modals", "allow-popups", "allow-scripts"].sort(),
    );
    expect(sandbox).not.toContain("allow-same-origin");
    expect(f.getAttribute("src")).toBe("/api/topics/t/artifacts/20/raw?v=100");
    expect(f.getAttribute("title")).toBe("Inbox mockup");
    expect(screen.getByRole("heading", { level: 1, name: "Inbox mockup" })).toBeTruthy();
    expect(screen.getByText("docs/inbox.html")).toBeTruthy();
  });

  it("offers Open in new tab at the raw URL with rel=noreferrer", async () => {
    open("/topic/t/doc/20");
    await frame();
    const a = screen.getByRole("link", { name: "Open in new tab" });
    expect(a.getAttribute("href")).toBe("/api/topics/t/artifacts/20/raw?v=100");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer");
  });

  it("goes back to the topic and toggles Wide", async () => {
    const loc = open("/topic/t/doc/20");
    await frame();
    const wide = screen.getByRole("button", { name: "Wide" });
    fireEvent.click(wide);
    expect(wide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("link", { name: /Back to topic/ }));
    await waitFor(() => expect(loc.history?.at(-1)).toBe("/topic/t"));
  });

  it("reloads the iframe when the file's mtime changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open("/topic/t/doc/20");
    await frame();
    server.artifacts.set("t:20", { ...html, mtime: 200 });
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(async () =>
      expect((await frame()).getAttribute("src")).toBe("/api/topics/t/artifacts/20/raw?v=200"),
    );
  });

  it("has an accessible header (axe cannot enter jsdom iframes)", async () => {
    open("/topic/t/doc/20");
    await frame();
    await expectAccessible(document.querySelector(".dv-head") as HTMLElement);
  });
});

describe("image artifact", () => {
  it("shows a fitted image with alt text from the label, and toggles actual size", async () => {
    open("/topic/t/doc/21");
    const img = (await screen.findByAltText("Relay")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/topics/t/artifacts/21/raw?v=100");
    expect(screen.queryByRole("link", { name: "Open in new tab" })).toBeNull();
    const btn = img.closest("button") as HTMLButtonElement;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".av-image")?.getAttribute("data-actual")).toBe("true");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("is accessible", async () => {
    open("/topic/t/doc/21");
    await screen.findByAltText("Relay");
    await expectAccessible(document.body);
  });

  it("explains a refused or missing file", async () => {
    server.details
      .get("t")
      ?.links?.push({ id: 30, kind: "artifact", target: "x.png", label: null });
    open("/topic/t/doc/30");
    expect((await screen.findByRole("alert")).textContent).toContain("no longer exists");
  });
});

describe("layouts", () => {
  it("opens in the Inbox reader", async () => {
    open("/topic/t/doc/20", "inbox");
    await frame();
    expect(document.querySelector("main.reader .dv iframe")).toBeTruthy();
  });

  it("opens in the Board sheet", async () => {
    open("/topic/t/doc/20", "board");
    await frame();
    const sheet = screen.getByRole("dialog", { name: "Document" });
    expect(sheet.querySelector(".dv iframe")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wide" }));
    expect(sheet.getAttribute("data-wide")).toBe("true");
  });

  it("opens in the Console panel, and wide hides the sidebar", async () => {
    open("/topic/t/doc/21", "console");
    await screen.findByAltText("Relay");
    expect(document.querySelector(".cs-panel .dv")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wide" }));
    expect(document.querySelector(".cs-app")?.getAttribute("data-wide")).toBe("true");
  });
});
