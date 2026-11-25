import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { entry, thread } from "../test/fakeApi";
import { History } from "./History";
import { entryLabel } from "./KindLabel";

const NOW = new Date("2026-11-25T12:00:00");

describe("entryLabel", () => {
  it("is author plus kind, in caps, without repeating YOU", () => {
    expect(entryLabel("agent", "finding")).toBe("AGENT FOUND");
    expect(entryLabel("agent", "verification")).toBe("AGENT CHECKED");
    expect(entryLabel("owner", "owner input")).toBe("YOU SAID");
    expect(entryLabel("owner", "authorization")).toBe("YOU ALLOWED");
    expect(entryLabel("owner", "decision")).toBe("YOU DECIDED");
    expect(entryLabel("axiom", "status change")).toBe("AXIOM STATUS");
    expect(entryLabel("axiom", "git event")).toBe("AXIOM GIT");
  });
});

describe("History", () => {
  it("shows an empty line without entries", () => {
    render(<History entries={[]} now={NOW} />);
    expect(screen.getByText("No history yet.")).toBeTruthy();
  });

  it("groups by day, newest first, with Today and Yesterday labels", () => {
    render(
      <History
        now={NOW}
        entries={[
          entry({ id: 1, at: "2026-11-24T10:00:00", body: "older" }),
          entry({ id: 2, at: "2026-11-25T08:00:00", body: "newer" }),
          entry({ id: 3, at: "2026-11-22T08:00:00", body: "oldest" }),
        ]}
      />,
    );
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Today, 25 Nov", "Yesterday, 24 Nov", "Sun 22 Nov"]);
  });

  it("renders each kind with its label, body and extras", () => {
    const { container } = render(
      <History
        now={NOW}
        threads={[thread({ id: 7, title: "Spec thread" })]}
        entries={[
          entry({
            id: 1,
            at: "2026-11-25T08:01:00",
            kind: "finding",
            body: "root cause",
            threadId: 7,
          }),
          entry({
            id: 2,
            at: "2026-11-25T08:02:00",
            kind: "verification",
            body: "all green",
            data: { result: "partial", evidence: ["shot.png"] },
            refs: [{ type: "thread", value: "thread:abc" }],
          }),
          entry({
            id: 3,
            at: "2026-11-25T08:03:00",
            author: "owner",
            kind: "owner input",
            body: "ok",
          }),
          entry({
            id: 4,
            at: "2026-11-25T08:04:00",
            author: "owner",
            kind: "authorization",
            body: "may rebase",
            data: { scope: "rebase only", standing: true },
          }),
          entry({
            id: 5,
            at: "2026-11-25T08:05:00",
            author: "axiom",
            kind: "status change",
            body: "wip -> hitl: asked",
            data: { from: "wip", to: "hitl", reason: "asked a question" },
          }),
          entry({
            id: 6,
            at: "2026-11-25T08:06:00",
            kind: "decision",
            body: "use SQLite",
            data: { why: "single file" },
          }),
        ]}
      />,
    );
    const li = (id: number) => container.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
    const of = (id: number) => {
      const el = li(id);
      if (!el) throw new Error(`no entry ${id}`);
      return within(el);
    };
    expect(of(1).getByText("AGENT FOUND")).toBeTruthy();
    expect(of(1).getByText("Spec thread")).toBeTruthy();
    expect(li(1)?.className).toContain("k-finding");
    expect(of(2).getByText("AGENT CHECKED")).toBeTruthy();
    expect(of(2).getByText("partial").className).toContain("r-partial");
    expect(of(2).getByText("thread:abc")).toBeTruthy();
    expect(of(2).getByText("shot.png", { exact: false })).toBeTruthy();
    expect(of(3).getByText("YOU SAID")).toBeTruthy();
    expect(of(4).getByText("YOU ALLOWED")).toBeTruthy();
    expect(of(4).getByText("standing")).toBeTruthy();
    expect(of(4).getByText("rebase only", { exact: false })).toBeTruthy();
    expect(of(5).getByText("AXIOM STATUS")).toBeTruthy();
    expect(of(5).getByText("wip")).toBeTruthy();
    expect(of(5).getByText("hitl")).toBeTruthy();
    expect(of(5).getByText("asked a question")).toBeTruthy();
    expect(of(6).getByText("single file", { exact: false })).toBeTruthy();
  });

  it("takes a density", () => {
    const { container, rerender } = render(
      <History now={NOW} entries={[entry({ id: 1 })]} density="dense" />,
    );
    expect(container.querySelector(".hist")?.className).toContain("dense");
    rerender(<History now={NOW} entries={[entry({ id: 1 })]} />);
    expect(container.querySelector(".hist")?.className).toContain("roomy");
  });

  it("deletes an entry only after an inline confirmation", () => {
    const onDelete = vi.fn();
    render(<History now={NOW} entries={[entry({ id: 9 })]} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete entry 9" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Delete this entry/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete entry 9" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(9);
  });

  it("has no delete control without a handler", () => {
    render(<History now={NOW} entries={[entry({ id: 9 })]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("History task status changes", () => {
  it("shows the task key and its task statuses, not topic statuses", () => {
    const { container } = render(
      <History
        entries={[
          entry({
            id: 1,
            at: "2026-11-25T08:00:00",
            author: "axiom",
            kind: "status change",
            body: "Task S7: to do -> wip",
            data: { task: "S7", from: "to do", to: "wip", by: "axiom" },
          }),
        ]}
      />,
    );
    const li = container.querySelector("[data-entry-id='1']") as HTMLElement;
    expect(li.textContent).toContain("Task S7");
    expect(li.querySelector(".pill.s-idle")?.textContent).toBe("to do");
    expect(li.querySelector(".pill.s-wip")?.textContent).toBe("wip");
  });
});
