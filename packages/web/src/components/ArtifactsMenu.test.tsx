import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkItem } from "../api";
import { ArtifactsMenu } from "./ArtifactsMenu";

const LINKS: LinkItem[] = [
  {
    id: 1,
    kind: "artifact",
    target: "docs/design/mockups/inbox.html",
    label: "Inbox mockup",
    description: "Mail-style triage",
  },
  {
    id: 2,
    kind: "artifact",
    target: "docs/design/references/relay.png",
    label: null,
    description: null,
  },
  { id: 3, kind: "artifact", target: "docs/plan.md", label: null, description: "The plan" },
  {
    id: 4,
    kind: "artifact",
    target: "https://example.com/report/q3.pdf",
    label: null,
    description: null,
  },
  { id: 5, kind: "artifact", target: "/tmp/data.zip", label: "Data", description: null },
];

function mount(links = LINKS) {
  return render(
    <>
      <button type="button">Elsewhere</button>
      <ArtifactsMenu links={links} slug="demo topic" />
    </>,
  );
}
const trigger = () => screen.getByRole("button", { name: /^Artifacts/ });
const menu = () => screen.getByRole("menu", { hidden: true });
const isOpen = () => menu().matches(":popover-open");
const items = () => within(menu()).getAllByRole("menuitem", { hidden: true });

describe("ArtifactsMenu", () => {
  it("shows one button with the artifact count", () => {
    mount();
    expect(screen.getAllByRole("button", { name: /^Artifacts/ })).toHaveLength(1);
    expect(trigger().getAttribute("aria-label")).toBe("Artifacts · 5");
    expect(trigger().textContent).toContain("Show 5");
    expect(trigger().getAttribute("popovertarget")).toBe(menu().id);
    expect(isOpen()).toBe(false);
  });

  it("opens on click, focuses the first item, and closes on Escape with focus back on the button", () => {
    mount();
    trigger().focus();
    fireEvent.click(trigger());
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(items()[0]);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on a click outside, and the button toggles it", () => {
    mount();
    fireEvent.click(trigger());
    expect(isOpen()).toBe(true);
    fireEvent.click(trigger());
    expect(isOpen()).toBe(false);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(isOpen()).toBe(false);
  });

  it("lists each artifact with title, description and path", () => {
    mount();
    const [html, image, md, web, zip] = items() as HTMLElement[];
    expect(within(html as HTMLElement).getByText("Inbox mockup")).toBeTruthy();
    expect(within(html as HTMLElement).getByText("Mail-style triage")).toBeTruthy();
    const path = within(html as HTMLElement).getByText("docs/design/mockups/inbox.html");
    expect(path.getAttribute("title")).toBe("docs/design/mockups/inbox.html");
    // No label: the file name. No description: nothing under the title.
    expect(within(image as HTMLElement).getByText("relay.png")).toBeTruthy();
    expect(image?.querySelector(".amenu-desc")).toBeNull();
    expect(within(md as HTMLElement).getByText("plan.md")).toBeTruthy();
    expect(within(web as HTMLElement).getByText("q3.pdf")).toBeTruthy();
    expect(within(zip as HTMLElement).getByText("Data")).toBeTruthy();
    // The kind is part of the accessible name.
    expect(html?.textContent).toContain("HTML page");
    expect(image?.textContent).toContain("Image");
    expect(md?.textContent).toContain("Markdown document");
    expect(web?.textContent).toContain("External link");
  });

  it("makes each item a real link: viewer route, new tab for external URLs, none for other files", () => {
    mount();
    const [html, image, md, web, zip] = items() as HTMLElement[];
    expect(html?.tagName).toBe("A");
    expect(html?.getAttribute("href")).toBe("/topic/demo%20topic/doc/1");
    expect(image?.getAttribute("href")).toBe("/topic/demo%20topic/doc/2");
    expect(md?.getAttribute("href")).toBe("/topic/demo%20topic/doc/3");
    expect(html?.hasAttribute("target")).toBe(false);
    expect(web?.tagName).toBe("A");
    expect(web?.getAttribute("href")).toBe("https://example.com/report/q3.pdf");
    expect(web?.getAttribute("target")).toBe("_blank");
    expect(web?.getAttribute("rel")).toBe("noreferrer");
    expect(zip?.hasAttribute("href")).toBe(false);
    expect(zip?.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the arrow keys and Escape from reaching the layouts' window shortcuts", () => {
    mount();
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", spy);
    fireEvent.click(trigger());
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    window.removeEventListener("keydown", spy);
    expect(seen).toEqual([]);
    expect(isOpen()).toBe(false);
  });

  it("closes after an item is activated", () => {
    mount();
    fireEvent.click(trigger());
    fireEvent.click(items()[0] as HTMLElement);
    expect(isOpen()).toBe(false);
  });

  it("moves between items with the arrow keys, Home and End, wrapping around", () => {
    mount();
    fireEvent.click(trigger());
    const list = items();
    const press = (key: string) => fireEvent.keyDown(document.activeElement as Element, { key });
    expect(document.activeElement).toBe(list[0]);
    press("ArrowDown");
    expect(document.activeElement).toBe(list[1]);
    press("ArrowUp");
    press("ArrowUp");
    expect(document.activeElement).toBe(list[4]);
    press("ArrowDown");
    expect(document.activeElement).toBe(list[0]);
    press("End");
    expect(document.activeElement).toBe(list[4]);
    press("Home");
    expect(document.activeElement).toBe(list[0]);
  });
});
