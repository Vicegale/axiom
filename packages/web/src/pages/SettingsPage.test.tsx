import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../App";
import { FakeServer, topic } from "../test/fakeApi";

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  server.topics = [topic({ slug: "quiet", title: "Quiet topic", muted: true })];
  server.install();
  const FakeNotification = {
    permission: "default" as NotificationPermission,
    requestPermission: vi.fn(async () => {
      FakeNotification.permission = "granted";
      return "granted" as NotificationPermission;
    }),
  };
  vi.stubGlobal("Notification", FakeNotification);
});
afterEach(() => vi.unstubAllGlobals());

function open() {
  render(<App router={{ hook: memoryLocation({ path: "/settings" }).hook }} />);
}

describe("Settings page", () => {
  it("offers all three layouts and saves the choice", async () => {
    open();
    const inbox = (await screen.findByLabelText("Inbox")) as HTMLInputElement;
    expect(inbox.checked).toBe(true);
    expect((screen.getByLabelText("Board") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Console") as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText("coming soon")).toBeNull();
    fireEvent.click(screen.getByLabelText("Board"));
    await waitFor(() =>
      expect(server.called("PUT", "/api/settings")[0]?.body).toEqual({ layout: "board" }),
    );
  });

  it("saves the theme", async () => {
    open();
    fireEvent.click(await screen.findByLabelText("Light"));
    await waitFor(() =>
      expect(server.called("PUT", "/api/settings")[0]?.body).toEqual({ theme: "light" }),
    );
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
  });

  it("mutes and unmutes kinds, sending the whole list", async () => {
    server.settings.mutedKinds = ["jira changed"];
    open();
    const jira = (await screen.findByLabelText("jira changed")) as HTMLInputElement;
    expect(jira.checked).toBe(true);
    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
    fireEvent.click(screen.getByLabelText("error"));
    await waitFor(() =>
      expect(server.called("PUT", "/api/settings")[0]?.body).toEqual({
        mutedKinds: ["jira changed", "error"],
      }),
    );
    fireEvent.click(screen.getByLabelText("jira changed"));
    await waitFor(() =>
      expect(server.called("PUT", "/api/settings")[1]?.body).toEqual({ mutedKinds: ["error"] }),
    );
  });

  it("lists muted topics and unmutes them", async () => {
    open();
    await screen.findByText("Quiet topic", { selector: ".muted-list span" });
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/topics/quiet/mute")[0]?.body).toEqual({ muted: false }),
    );
    await screen.findByText("No topics are muted.");
  });

  it("saves the stale threshold", async () => {
    open();
    const input = (await screen.findByLabelText("Days idle before the prompt")) as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "30" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(server.called("PUT", "/api/settings")[0]?.body).toEqual({ staleAfterDays: 30 }),
    );
  });

  it("shows the browser permission and requests it", async () => {
    open();
    await screen.findByText("Not asked yet.");
    fireEvent.click(screen.getByRole("button", { name: "Allow browser notifications" }));
    await screen.findByText(/Granted/);
    expect(screen.queryByRole("button", { name: "Allow browser notifications" })).toBeNull();
  });
});
