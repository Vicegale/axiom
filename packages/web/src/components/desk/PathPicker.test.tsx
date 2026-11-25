import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectAccessible } from "../../test/axe";
import {
  detectHome,
  folderGroups,
  PathPicker,
  type PickGroup,
  projectGroups,
  shortPath,
} from "./PathPicker";

const HOME = "/home/vic";
const projects = [
  { id: "a", title: "Atlas", workspaceRoot: `${HOME}/projects/atlas`, pinned: false },
  {
    id: "g",
    title: "GPTCommandCenter",
    workspaceRoot: `${HOME}/Documents/notes/GPTCommandCenter`,
    pinned: true,
  },
  { id: "m", title: "MTG", workspaceRoot: `${HOME}/projects/mtg`, pinned: true },
  { id: "z", title: "Zed", workspaceRoot: "/srv/zed", pinned: false },
];
const workspaces = [
  { path: `${HOME}/projects/mtg`, label: "~/projects/mtg", source: "axiom" as const },
  { path: `${HOME}/projects/solo`, label: "~/projects/solo", source: "axiom" as const },
  { path: `${HOME}/projects/atlas`, label: "~/projects/atlas", source: "projects" as const },
  { path: `${HOME}/projects/other`, label: "~/projects/other", source: "projects" as const },
];

describe("shortPath and detectHome", () => {
  it("replaces the home directory with ~", () => {
    expect(shortPath(`${HOME}/projects/atlas`, HOME)).toBe("~/projects/atlas");
    expect(shortPath(HOME, HOME)).toBe("~");
    expect(shortPath("/home/vicious/x", HOME)).toBe("/home/vicious/x");
  });
  it("puts an ellipsis in the middle of a long path", () => {
    expect(shortPath(`${HOME}/Documents/notes/GPTCommandCenter/skills/deep`, HOME)).toBe(
      "~/Documents/notes/…/deep",
    );
    expect(shortPath(`${HOME}/Documents/notes/archive-2026/GPTCommandCenter`, HOME)).toBe(
      "~/Documents/notes/…/GPTCommandCenter",
    );
    expect(shortPath("/short/one", HOME)).toBe("/short/one");
  });
  it("finds the home directory from a workspace label or a /home/user path", () => {
    expect(detectHome(workspaces)).toBe(HOME);
    expect(detectHome([], ["/srv/x", "/Users/ann/code/y"])).toBe("/Users/ann");
    expect(detectHome([], ["/srv/x"])).toBeNull();
  });
});

describe("groups", () => {
  it("lists Recent (Axiom topics, newest first), Pinned, then All projects, each project once", () => {
    const g = projectGroups(projects, workspaces);
    expect(g.map((x) => [x.label, x.items.map((i) => i.title)])).toEqual([
      ["Recent", ["MTG"]],
      ["Pinned", ["GPTCommandCenter"]],
      ["All projects", ["Atlas", "Zed"]],
    ]);
  });
  it("lists Recent, T3 projects and ~/projects for a folder, each folder once", () => {
    const g = folderGroups(projects, workspaces);
    expect(g.map((x) => [x.label, x.items.map((i) => i.title)])).toEqual([
      ["Recent", ["MTG", "solo"]],
      ["T3 projects", ["Atlas", "GPTCommandCenter", "Zed"]],
      ["~/projects", ["other"]],
    ]);
  });
});

function Harness({
  groups,
  onChange = () => {},
  onAction,
  allowPath,
  value = "",
}: {
  groups: PickGroup[];
  onChange?: (v: string) => void;
  onAction?: () => void;
  allowPath?: boolean;
  value?: string;
}) {
  return (
    <PathPicker
      name="Project"
      display="Project"
      valueText="none"
      value={value}
      groups={groups}
      home={HOME}
      onChange={onChange}
      onAction={onAction}
      allowPath={allowPath}
      action={onAction ? { value: "x", label: "Type a path…" } : undefined}
    />
  );
}

const menu = () => document.querySelector(".pp-menu") as HTMLElement;
const open = () => {
  const el = menu();
  el.hidePopover = vi.fn();
  act(() => {
    el.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open", oldState: "closed" }));
  });
};
const search = () => screen.getByRole("combobox", { hidden: true }) as HTMLInputElement;
const options = () => screen.getAllByRole("option", { hidden: true });
const names = () => options().map((o) => o.querySelector(".pp-title")?.textContent);
const typeQuery = (v: string) => fireEvent.change(search(), { target: { value: v } });
const activeName = () =>
  document.getElementById(search().getAttribute("aria-activedescendant") ?? "")?.textContent;

beforeEach(() => {
  window.HTMLElement.prototype.hidePopover = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("PathPicker", () => {
  const groups = () => projectGroups(projects, workspaces);

  it("filters by title and by path, case-insensitively, anywhere in the text", () => {
    render(<Harness groups={groups()} />);
    open();
    expect(names()).toEqual(["MTG", "GPTCommandCenter", "Atlas", "Zed"]);
    typeQuery("cOMMand");
    expect(names()).toEqual(["GPTCommandCenter"]);
    typeQuery("/srv");
    expect(names()).toEqual(["Zed"]);
    typeQuery("projects/at");
    expect(names()).toEqual(["Atlas"]);
  });

  it("highlights the matched part of the title and shows No matches", () => {
    render(<Harness groups={groups()} />);
    open();
    typeQuery("command");
    const mark = menu().querySelector("mark");
    expect(mark?.textContent).toBe("Command");
    typeQuery("nothing-like-this");
    expect(screen.queryAllByRole("option", { hidden: true })).toHaveLength(0);
    expect(within(menu()).getByRole("status", { hidden: true }).textContent).toBe("No matches");
  });

  it("shows shortened paths, full paths as tooltips, and a check on the selected row", () => {
    render(<Harness groups={groups()} value="g" />);
    const row = options().find((o) => o.textContent?.startsWith("GPTCommandCenter")) as HTMLElement;
    expect(row.title).toBe(`${HOME}/Documents/notes/GPTCommandCenter`);
    expect(row.querySelector(".pp-path")?.textContent).toBe("~/Documents/notes/GPTCommandCenter");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(options().filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("is a combobox: arrows move aria-activedescendant, Enter picks", () => {
    const onChange = vi.fn();
    render(<Harness groups={groups()} onChange={onChange} />);
    open();
    expect(search().getAttribute("aria-controls")).toBe(
      screen.getByRole("listbox", { hidden: true }).id,
    );
    expect(activeName()).toMatch(/^MTG/);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(activeName()).toMatch(/^GPTCommandCenter/);
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(activeName()).toMatch(/^Zed/);
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("g");
    expect(menu().hidePopover).toHaveBeenCalled();
  });

  it("clears the query on Escape, then closes", () => {
    render(<Harness groups={groups()} />);
    open();
    typeQuery("zed");
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search().value).toBe("");
    expect(names()).toHaveLength(4);
    expect(menu().hidePopover).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(menu().hidePopover).toHaveBeenCalledTimes(1);
  });

  it("offers Use <path> first for a path-like query, and the pinned action last", () => {
    const onChange = vi.fn();
    const onAction = vi.fn();
    render(
      <Harness
        groups={folderGroups(projects, workspaces)}
        allowPath
        onChange={onChange}
        onAction={onAction}
      />,
    );
    open();
    expect(names().at(-1)).toBe("Type a path…");
    typeQuery("/tmp/new");
    expect(names()[0]).toBe("Use /tmp/new");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("/tmp/new");
    typeQuery("zzz");
    expect(names()).toEqual(["Type a path…"]);
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onAction).toHaveBeenCalled();
  });

  it("opens upward when there is no room below, and stays on screen", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    render(<Harness groups={groups()} />);
    const chip = screen.getByRole("button", { name: "Project: none" });
    chip.getBoundingClientRect = () =>
      ({ top: 740, bottom: 770, left: 1300, right: 1400, width: 100, height: 30 }) as DOMRect;
    open();
    expect(menu().dataset.side).toBe("up");
    expect(menu().style.top).toBe("auto");
    expect(menu().style.bottom).toBe("64px");
    expect(Number.parseInt(menu().style.left, 10)).toBeLessThanOrEqual(1440 - 384 - 8);
    chip.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, left: 20, right: 120, width: 100, height: 30 }) as DOMRect;
    open();
    expect(menu().dataset.side).toBe("down");
    expect(menu().style.top).toBe("134px");
  });

  it("has no accessibility violations", async () => {
    render(<Harness groups={groups()} onAction={() => {}} />);
    open();
    await expectAccessible();
  });
});
