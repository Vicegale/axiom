import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinkItem, TaskItem } from "../api";
import { linkTasks, task } from "../test/fakeApi";
import { GraphSection, TaskBadge, TasksSection } from "./Tasks";

const links: LinkItem[] = [
  { id: 1, kind: "spec", target: "docs/plan.md", label: "Build plan" },
  { id: 2, kind: "spec", target: "docs/other.md", label: null },
  { id: 3, kind: "pr", target: "o/r#1", label: null },
];

function demo(): TaskItem[] {
  return linkTasks([
    task({ key: "S0", title: "Setup", status: "done", specLinkId: 1 }),
    task({ key: "S1", title: "Core", status: "wip", specLinkId: 1, dependsOn: ["S0"] }),
    task({ key: "S2", title: "Web", specLinkId: 1, dependsOn: ["S1"], doneWhen: "It renders" }),
    task({ key: "S3", title: "Docs", specLinkId: 2 }),
    task({ key: "S4", title: "Loose", status: "blocked", dependsOn: ["S1", "S3"] }),
  ]);
}

describe("TasksSection", () => {
  it("groups by spec with progress, then No spec, and shows who a waiting task waits on", () => {
    render(<TasksSection tasks={demo()} links={links} picked={null} onStatus={vi.fn()} />);
    const heads = [...document.querySelectorAll(".task-group h3")].map((h) => h.textContent);
    expect(heads).toEqual(["Build plan1/3 done", "docs/other.md0/1 done", "No spec0/1 done"]);
    expect(screen.getByText("1/5 done")).toBeTruthy();
    expect(document.querySelector("#task-S2")?.textContent).toContain("waits on S1");
    expect(document.querySelector("#task-S4")?.textContent).toContain("waits on S1, S3");
    expect(document.querySelector("#task-S0")?.textContent).not.toContain("waits on");
    expect(document.querySelector("#task-S2")?.classList.contains("is-waiting")).toBe(true);
    expect(document.querySelector("#task-S0")?.classList.contains("is-waiting")).toBe(false);
  });

  it("shows done-when on hover (title) and on expand", () => {
    render(<TasksSection tasks={demo()} links={links} picked={null} onStatus={vi.fn()} />);
    const row = document.querySelector("#task-S2") as HTMLElement;
    expect(row.getAttribute("title")).toBe("Done when: It renders");
    expect(screen.queryByText("It renders")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Web" }));
    expect(within(row).getByText("It renders")).toBeTruthy();
    // a task without done-when has nothing to expand
    expect(
      within(document.querySelector("#task-S0") as HTMLElement).queryByRole("button"),
    ).toBeNull();
  });

  it("reports a status change from the row's menu", () => {
    const onStatus = vi.fn();
    render(<TasksSection tasks={demo()} links={links} picked={null} onStatus={onStatus} />);
    const select = screen.getByRole("combobox", { name: "Status of S3" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["to do", "wip", "blocked", "done"]);
    fireEvent.change(select, { target: { value: "wip" } });
    expect(onStatus).toHaveBeenCalledWith("S3", "wip");
  });

  it("highlights and scrolls to the picked task", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <TasksSection tasks={demo()} links={links} picked={{ key: "S1", n: 1 }} onStatus={vi.fn()} />,
    );
    expect(document.querySelector("#task-S1")?.classList.contains("is-picked")).toBe(true);
    expect(document.querySelector("#task-S2")?.classList.contains("is-picked")).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("says so when there are no tasks", () => {
    render(<TasksSection tasks={[]} links={[]} picked={null} onStatus={vi.fn()} />);
    expect(screen.getByText(/No tasks yet/)).toBeTruthy();
  });
});

describe("GraphSection", () => {
  it("draws one node per task and one arrow per dependency, on the dotted grid wrapper", () => {
    render(<GraphSection tasks={demo()} onPick={vi.fn()} />);
    expect(document.querySelectorAll(".g-node")).toHaveLength(5);
    expect(document.querySelectorAll(".g-edge")).toHaveLength(4);
    expect(document.querySelector(".graph-scroll svg.graph")).toBeTruthy();
    const edge = document.querySelector('.g-edge[data-from="S1"][data-to="S2"]');
    expect(edge?.getAttribute("marker-end")).toMatch(/^url\(#.+-arrow\)$/);
  });

  it("dims waiting tasks and colours by status", () => {
    render(<GraphSection tasks={demo()} onPick={vi.fn()} />);
    const node = (k: string) => document.querySelector(`.g-node[data-task-key="${k}"]`) as Element;
    expect(node("S0").classList.contains("is-waiting")).toBe(false);
    expect(node("S2").classList.contains("is-waiting")).toBe(true);
    expect(node("S3").classList.contains("is-waiting")).toBe(false);
    expect(node("S0").classList.contains("s-done")).toBe(true);
    expect(node("S1").classList.contains("s-wip")).toBe(true);
    expect(node("S4").classList.contains("s-blocked")).toBe(true);
    expect(node("S3").classList.contains("s-idle")).toBe(true);
  });

  it("truncates long titles but keeps the full one in the tooltip", () => {
    const long = linkTasks([task({ key: "L", title: "A very long task title that overflows" })]);
    render(<GraphSection tasks={long} onPick={vi.fn()} />);
    const node = document.querySelector('.g-node[data-task-key="L"]') as Element;
    expect(node.querySelector(".g-title")?.textContent).toMatch(/…$/);
    expect(node.querySelector("title")?.textContent).toContain(
      "A very long task title that overflows",
    );
  });

  it("hover lights the node, its dependencies and dependents, and fades the rest", () => {
    render(<GraphSection tasks={demo()} onPick={vi.fn()} />);
    const node = (k: string) => document.querySelector(`.g-node[data-task-key="${k}"]`) as Element;
    fireEvent.mouseEnter(node("S1"));
    const lit = [...document.querySelectorAll(".g-node.is-lit")].map((n) =>
      n.getAttribute("data-task-key"),
    );
    expect(lit.sort()).toEqual(["S0", "S1", "S2", "S4"]);
    expect(node("S3").classList.contains("is-faded")).toBe(true);
    expect(document.querySelectorAll(".g-edge.is-lit")).toHaveLength(3);
    fireEvent.mouseLeave(node("S1"));
    expect(document.querySelectorAll(".is-lit, .is-faded")).toHaveLength(0);
  });

  it("reports a click or Enter on a node", () => {
    const onPick = vi.fn();
    render(<GraphSection tasks={demo()} onPick={onPick} />);
    const s2 = screen.getByRole("button", { name: /^S2: Web, to do, waits on S1/ });
    fireEvent.click(s2);
    fireEvent.keyDown(s2, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenCalledWith("S2");
  });

  it("stays readable for about 30 tasks: every node is laid out, none overlaps", () => {
    const many: TaskItem[] = [];
    for (let i = 0; i < 30; i++) {
      many.push(
        task({
          key: `T${i}`,
          title: `Task number ${i}`,
          dependsOn:
            i === 0 ? [] : [`T${Math.floor((i - 1) / 2)}`, ...(i > 4 ? [`T${i - 3}`] : [])],
        }),
      );
    }
    linkTasks(many);
    render(<GraphSection tasks={many} onPick={vi.fn()} />);
    expect(document.querySelectorAll(".g-node")).toHaveLength(30);
    const spots = [...document.querySelectorAll(".g-node")].map((n) => n.getAttribute("transform"));
    expect(new Set(spots).size).toBe(30);
  });
});

describe("TaskBadge", () => {
  it("shows done/total, and nothing without tasks", () => {
    const { rerender } = render(<TaskBadge counts={{ total: 8, done: 5 }} />);
    expect(screen.getByTestId("task-badge").textContent).toContain("5/8");
    rerender(<TaskBadge counts={{ total: 0, done: 0 }} />);
    expect(screen.queryByTestId("task-badge")).toBeNull();
  });
});
