import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./App";
import { FakeServer } from "./test/fakeApi";
import { seedTracker } from "./test/seed";

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  seedTracker(server);
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

describe("layout switch", () => {
  it("picks the shell from settings.layout", async () => {
    for (const [layout, marker] of [
      ["inbox", ".rail"],
      ["board", ".bd-board"],
      ["console", ".cs-table"],
    ] as const) {
      server.settings.layout = layout;
      const { unmount } = render(<App router={{ hook: memoryLocation({ path: "/" }).hook }} />);
      await waitFor(() => expect(document.querySelector(marker)).toBeTruthy());
      unmount();
    }
  });

  it("switching on the Settings page changes the shell, and the next topic opens in it", async () => {
    const loc = memoryLocation({ path: "/settings", record: true });
    render(<App router={{ hook: loc.hook }} />);
    fireEvent.click(await screen.findByLabelText("Console"));
    await waitFor(() => expect(document.querySelector(".cs-app")).toBeTruthy());
    expect(loc.history?.at(-1)).toBe("/settings");
    loc.navigate("/topic/ask");
    await screen.findByRole("region", { name: "Selected topic" });
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    fireEvent.click(await screen.findByLabelText("Board"));
    await waitFor(() => expect(document.querySelector(".bd-app")).toBeTruthy());
  });

  it("keeps the open topic when the layout changes under it", async () => {
    server.settings.layout = "board";
    const loc = memoryLocation({ path: "/topic/ask", record: true });
    render(<App router={{ hook: loc.hook }} />);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("Needs me");

    // Another tab (or the settings page) changes the layout; this one picks it up on refetch.
    server.settings.layout = "console";
    fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
    const panel = await screen.findByRole("region", { name: "Selected topic" });
    expect(panel.textContent).toContain("ask");
    expect(loc.history?.at(-1)).toBe("/topic/ask");
    expect(document.querySelector('tr[data-slug="ask"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );

    server.settings.layout = "inbox";
    fireEvent.click(screen.getByRole("button", { name: /^(Light|Dark) theme$/ }));
    await waitFor(() => expect(document.querySelector(".reader")).toBeTruthy());
    expect(loc.history?.at(-1)).toBe("/topic/ask");
    await screen.findByRole("heading", { level: 1, name: "Needs me" });
  });
});
