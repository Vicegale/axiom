import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import { expectAccessible } from "../../test/axe";
import { deskTopic, FakeServer } from "../../test/fakeApi";
import { seedTracker } from "../../test/seed";

let server: FakeServer;

beforeEach(() => {
  window.localStorage.clear();
  server = new FakeServer();
  seedTracker(server);
  server.desk = [deskTopic({ slug: "alpha", title: "Alpha", status: "wip" })];
  server.workspaces = [
    { path: "/home/u/projects/foo", label: "~/projects/foo", source: "projects" },
  ];
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

async function openDialog() {
  const loc = memoryLocation({ path: "/desk", record: true });
  render(<App router={{ hook: loc.hook }} />);
  await screen.findByRole("article", { name: "Alpha" });
  fireEvent.click(screen.getByRole("button", { name: "+ New topic" }));
  return screen.findByRole("dialog", { name: "New topic" });
}
const field = (name: string | RegExp) => screen.getByLabelText(name) as HTMLInputElement;
const type = (name: string | RegExp, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: /^(Create|Retry)/ }));

describe("+ New topic", () => {
  it("opens from the button with the title focused, and is accessible", async () => {
    const dialog = await openDialog();
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(field("Title"));
    expect(screen.getByRole("button", { name: "Create topic" })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll("datalist option")).toHaveLength(1));
    await expectAccessible();
  });

  it("opens with the n key unless the focus is in a text field", async () => {
    const loc = memoryLocation({ path: "/desk", record: true });
    render(<App router={{ hook: loc.hook }} />);
    await screen.findByRole("article", { name: "Alpha" });
    fireEvent.keyDown(document.body, { key: "n" });
    await screen.findByRole("dialog", { name: "New topic" });
    // Typing n in the title does not open a second one or get swallowed.
    const ev = new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true });
    field("Title").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("does not open from n inside a text field on the Desk", async () => {
    const loc = memoryLocation({ path: "/desk", record: true });
    render(<App router={{ hook: loc.hook }} />);
    await screen.findByRole("article", { name: "Alpha" });
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "n" });
    expect(screen.queryByRole("dialog")).toBeNull();
    input.remove();
  });

  it("requires a title, and a folder only with a first message", async () => {
    await openDialog();
    submit();
    expect(await screen.findByText("A title is required.")).toBeTruthy();
    expect(server.called("POST", "/api/topics")).toHaveLength(0);
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    submit();
    expect(await screen.findByText(/Pick the project folder/)).toBeTruthy();
    expect(server.called("POST", "/api/topics")).toHaveLength(0);
    expect(document.activeElement).toBe(field(/^Project folder/));
  });

  it("creates the topic only, with goal, parent and folder", async () => {
    server.epics = [
      { id: 1, slug: "e1", title: "Big epic", ticketCount: 0, topicCount: 0 },
    ] as never;
    await openDialog();
    await screen.findByRole("option", { name: "Big epic" });
    type("Title", "Fix it");
    type(/^Goal/, "Be done");
    type(/^Project folder/, "/home/u/projects/foo");
    type(/^Parent/, "epic:e1");
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics")[0]?.body).toEqual({
      title: "Fix it",
      goal: "Be done",
      epic: "e1",
      repository: "/home/u/projects/foo",
    });
    expect(server.calls.filter((c) => c.path.endsWith("/threads/new"))).toHaveLength(0);
  });

  it("creates and starts a T3 thread, passing the Claude provider instance for a model", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^Project folder/, "/home/u/projects/foo");
    type(/^First message/, "Do the thing");
    expect(screen.getByRole("button", { name: "Create and start" })).toBeTruthy();
    type("Model", "claude-opus-5-5");
    type("Effort", "high");
    expect(screen.getByText(/claudeAgent/)).toBeTruthy();
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics")).toHaveLength(1);
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toEqual({
      text: "Do the thing",
      provider: "t3",
      project: "/home/u/projects/foo",
      providerInstance: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "high",
    });
  });

  it("starts a Claude Code thread with cwd and no provider instance", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^Project folder/, "/home/u/projects/foo");
    type(/^First message/, "Do the thing");
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    type("Model", "claude-sonnet-5-5");
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toEqual({
      text: "Do the thing",
      provider: "claude-code",
      cwd: "/home/u/projects/foo",
      model: "claude-sonnet-5-5",
    });
  });

  it("keeps the dialog on a start failure and retries without creating a second topic", async () => {
    server.newThreadFails = 1;
    await openDialog();
    type("Title", "Fix it");
    type(/^Project folder/, "/home/u/projects/foo");
    type(/^First message/, "Do the thing");
    submit();
    const alert = await screen.findByText(/did not start: .*exited with 1/);
    expect(alert).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry start" });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics")).toHaveLength(1);
    expect(server.called("POST", "/api/topics/fix-it/threads/new")).toHaveLength(2);
  });

  it("shows a create error inline and lets the owner fix it", async () => {
    server.createTopicFails = true;
    await openDialog();
    type("Title", "Fix it");
    submit();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("slug taken")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create topic" })).toBeTruthy();
  });

  it("scrolls the new card into view and flashes it", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await openDialog();
    type("Title", "Fix it");
    submit();
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const el = document.querySelector('[data-slug="fix-it"]');
    expect(el).toBeTruthy();
    expect(el?.classList.contains("nt-flash")).toBe(true);
  });

  it("submits with Ctrl+Enter", async () => {
    await openDialog();
    type("Title", "Fix it");
    fireEvent.keyDown(field("Title"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(server.called("POST", "/api/topics")).toHaveLength(1));
  });

  it("closes on Escape when empty, asks to discard when filled, and returns focus", async () => {
    await openDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "+ New topic" })),
    );

    fireEvent.click(screen.getByRole("button", { name: "+ New topic" }));
    await screen.findByRole("dialog", { name: "New topic" });
    type("Title", "Half typed");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(await screen.findByText("Discard this new topic?")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard this new topic?")).toBeNull();
    expect(field("Title").value).toBe("Half typed");
    fireEvent.keyDown(field("Title"), { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics")).toHaveLength(0);
  });
});
