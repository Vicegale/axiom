import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { notification } from "../test/fakeApi";
import { NotificationsList } from "./NotificationsList";

it("lists notifications with kind, topic title and body, and opens the topic", () => {
  const onOpen = vi.fn();
  render(
    <NotificationsList
      now={new Date("2026-11-25T12:00:00")}
      notifications={[notification({ id: 1, kind: "agent asked", topicSlug: "a", body: "Which?" })]}
      titleOf={(s) => (s === "a" ? "Topic A" : undefined)}
      onOpen={onOpen}
    />,
  );
  expect(screen.getByText("agent asked")).toBeTruthy();
  expect(screen.getByText("Which?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Topic A" }));
  expect(onOpen).toHaveBeenCalledWith("a");
});

it("says when nothing is there and how many are hidden by mutes", () => {
  render(<NotificationsList notifications={[]} hiddenCount={3} onOpen={() => {}} />);
  expect(screen.getByText("No notifications right now.")).toBeTruthy();
  expect(screen.getByText("3 hidden by your mutes.")).toBeTruthy();
});
