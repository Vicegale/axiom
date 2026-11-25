import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TopicDetailData } from "../api";
import { entry, thread, topic } from "../test/fakeApi";
import { TopicDetail, type TopicDetailActions } from "./TopicDetail";

const NOW = new Date("2026-11-25T12:00:00");

function detail(over: Partial<TopicDetailData> = {}): TopicDetailData {
  const base = topic({ slug: "demo", title: "Demo topic", status: "wip" });
  return {
    ...base,
    openThreadStatuses: [],
    threads: [],
    links: [],
    monitorTargets: [],
    ...over,
  } as TopicDetailData;
}

function actions(): TopicDetailActions {
  return {
    onToggleMute: vi.fn(),
    onMarkStale: vi.fn(),
    onDismissStale: vi.fn(),
    onConfirmMonitor: vi.fn(),
    onDeleteEntry: vi.fn(),
    onTaskStatus: vi.fn(),
  };
}

describe("TopicDetail", () => {
  it("shows the header, goal, status note and attention callout", () => {
    render(
      <TopicDetail
        now={NOW}
        topic={detail({
          status: "hitl",
          goal: "Ship it",
          statusNote: "waiting",
          attention: { reason: "agent asked", text: "Which way?", at: "2026-11-25T09:00:00.000Z" },
        })}
        entries={[]}
        actions={actions()}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Demo topic");
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByText("waiting")).toBeTruthy();
    const callout = screen.getByRole("note");
    expect(callout.textContent).toContain("agent asked:");
    expect(callout.textContent).toContain("Which way?");
  });

  it("explains a null status", () => {
    render(
      <TopicDetail now={NOW} topic={detail({ status: null })} entries={[]} actions={actions()} />,
    );
    expect(screen.getByText(/no status of its own/)).toBeTruthy();
  });

  it("offers mute and unmute", () => {
    const a = actions();
    const { rerender } = render(
      <TopicDetail now={NOW} topic={detail()} entries={[]} actions={a} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mute topic" }));
    expect(a.onToggleMute).toHaveBeenLastCalledWith(true);
    rerender(<TopicDetail now={NOW} topic={detail({ muted: true })} entries={[]} actions={a} />);
    const btn = screen.getByRole("button", { name: "Muted" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(a.onToggleMute).toHaveBeenLastCalledWith(false);
  });

  it("shows the stale prompt with both actions", () => {
    const a = actions();
    render(
      <TopicDetail
        now={NOW}
        topic={detail({ status: "idle", stalePrompt: true, lastWorkedAt: "2026-11-04T12:00:00" })}
        entries={[]}
        actions={a}
      />,
    );
    expect(screen.getByText("Idle for 21 days. Mark as stale?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark stale" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(a.onMarkStale).toHaveBeenCalledOnce();
    expect(a.onDismissStale).toHaveBeenCalledOnce();
  });

  it("has no stale prompt otherwise", () => {
    render(<TopicDetail now={NOW} topic={detail()} entries={[]} actions={actions()} />);
    expect(screen.queryByRole("group", { name: "Mark as stale?" })).toBeNull();
  });

  it("lists parents with Jira key, status and lock, and the epic of a ticket", () => {
    render(
      <TopicDetail
        now={NOW}
        topic={detail({
          parents: [
            {
              kind: "ticket",
              slug: "t1",
              title: "Wave I",
              status: "wip",
              jiraKey: "MTG-214",
              jiraStatus: "In Progress",
              locked: true,
            },
            {
              kind: "epic",
              slug: "e1",
              title: "Axiom",
              status: "wip",
              jiraKey: null,
              jiraStatus: null,
              locked: false,
            },
          ],
        })}
        ticketEpics={{ t1: "MTG next phase 2" }}
        entries={[]}
        actions={actions()}
      />,
    );
    expect(screen.getByText("MTG-214 In Progress")).toBeTruthy();
    expect(screen.getByLabelText("Status owned by Jira")).toBeTruthy();
    expect(screen.getByText("in MTG next phase 2")).toBeTruthy();
    expect(screen.getAllByLabelText("Status owned by Jira")).toHaveLength(1);
  });

  it("shows threads, links grouped by kind, and monitor targets with Confirm only when suggested", () => {
    const a = actions();
    render(
      <TopicDetail
        now={NOW}
        topic={detail({
          threads: [thread({ id: 1, title: "Main", provider: "claude-code", status: "wip" })],
          links: [
            { id: 10, kind: "pr", target: "o/r#1", label: "First PR" },
            { id: 11, kind: "repository", target: "~/projects/x", label: null },
          ],
          monitorTargets: [
            { id: 5, linkId: 10, kind: "pr-checks", state: "suggested" },
            { id: 6, linkId: 11, kind: "deploy-health", state: "confirmed" },
          ],
        })}
        entries={[entry({ id: 1 })]}
        actions={a}
      />,
    );
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Main")).toBeTruthy();
    expect(screen.getByText("Pull requests")).toBeTruthy();
    expect(screen.getByText("Repository")).toBeTruthy();
    expect(screen.getByText("First PR")).toBeTruthy();
    const confirms = screen.getAllByRole("button", { name: "Confirm" });
    expect(confirms).toHaveLength(1);
    fireEvent.click(confirms[0] as HTMLElement);
    expect(a.onConfirmMonitor).toHaveBeenCalledWith(5);
  });

  it("passes the density to the history and wires delete", () => {
    const a = actions();
    const { container } = render(
      <TopicDetail
        now={NOW}
        topic={detail()}
        entries={[entry({ id: 4 })]}
        density="dense"
        actions={a}
      />,
    );
    expect(container.querySelector(".hist.dense")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete entry 4" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(a.onDeleteEntry).toHaveBeenCalledWith(4);
  });
});

describe("TopicDetail T3 picker", () => {
  it("offers the Attach T3 thread button in the Threads section", () => {
    render(<TopicDetail now={NOW} topic={detail()} entries={[]} actions={actions()} />);
    expect(screen.getByRole("button", { name: "Attach T3 thread" })).toBeTruthy();
  });
});
