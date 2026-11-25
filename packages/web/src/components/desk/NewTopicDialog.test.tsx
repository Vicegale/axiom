import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  server.t3Projects = [
    {
      id: "proj-foo",
      title: "Foo",
      workspaceRoot: "/home/u/projects/foo",
      hasDefaultModel: true,
      pinned: true,
    },
    {
      id: "proj-bare",
      title: "Bare",
      workspaceRoot: "/home/u/projects/bare",
      hasDefaultModel: false,
      pinned: false,
    },
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
const submit = () =>
  fireEvent.click(
    within(document.querySelector(".nt-actions") as HTMLElement).getByRole("button", {
      name: /^(Create|Retry)/,
    }),
  );

const chip = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const pick = (chipName: string | RegExp, option: string) => {
  fireEvent.click(chip(chipName));
  const re = new RegExp(`^${option}`);
  fireEvent.click(
    screen.queryByRole("menuitemradio", { name: re, hidden: true }) ??
      screen.getByRole("option", { name: re, hidden: true }),
  );
};
const send = () =>
  within(screen.getByRole("dialog")).getByLabelText(/^(Create and start|Retry start)/);

describe("+ New topic: T3 projects", () => {
  it("sets the folder with the composer's Project chip, even without a first message", async () => {
    await openDialog();
    expect(screen.queryByLabelText(/^Project folder/)).toBeNull();
    expect(chip("Project: none")).toBeTruthy();
  });

  it("has a Project chip for a T3 first thread and a Folder chip for Claude Code", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    expect(chip("Project: none")).toBeTruthy();
    fireEvent.click(chip("Project: none"));
    expect(
      screen
        .getAllByRole("option", { hidden: true })
        .map((o) => o.textContent)
        .filter((t) => /projects\//.test(t ?? "")),
    ).toEqual(["Foo~/projects/foo", "Bare~/projects/bare"]);
    // The plain folder field is replaced by the chip once a message is written.
    expect(screen.queryByLabelText(/^Project folder/)).toBeNull();
    pick("Provider: T3", "Claude Code");
    expect(screen.queryByRole("button", { name: /^Project:/ })).toBeNull();
    expect(chip("Folder: none")).toBeTruthy();
  });

  it("requires a project, then sends its id and sets the repository from its folder", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    submit();
    expect(await screen.findByText("Choose the T3 project to start a thread in.")).toBeTruthy();
    expect(document.activeElement).toBe(chip("Project: none"));
    expect(server.called("POST", "/api/topics")).toHaveLength(0);
    pick("Project: none", "Foo");
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics")[0]?.body).toMatchObject({
      repository: "/home/u/projects/foo",
    });
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toEqual({
      text: "Do the thing",
      provider: "t3",
      project: "proj-foo",
    });
  });

  it("requires a model for a project without a default model", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    pick("Project: none", "Bare");
    expect(screen.getByText(/project has no default model, so one is required/)).toBeTruthy();
    expect(chip("Model: required")).toBeTruthy();
    expect(send().hasAttribute("disabled")).toBe(true);
    expect((send() as HTMLButtonElement).title).toMatch(/Choose a model/);
    submit();
    expect(await screen.findByText("This project has no default model: choose one.")).toBeTruthy();
    expect(server.called("POST", "/api/topics")).toHaveLength(0);
    pick("Model: required", "claude-opus-5-5");
    expect(send().hasAttribute("disabled")).toBe(false);
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toMatchObject({
      project: "proj-bare",
      model: "claude-opus-5-5",
      providerInstance: "claudeAgent",
    });
  });

  it("does not ask for a model when the project has a default", async () => {
    await openDialog();
    type(/^First message/, "Do the thing");
    pick("Project: none", "Foo");
    expect(screen.queryByText(/so one is required/)).toBeNull();
    expect(chip("Model: default")).toBeTruthy();
  });

  it("groups the Folder picker and shows the chosen folder's last segment", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    pick("Provider: T3", "Claude Code");
    fireEvent.click(chip("Folder: none"));
    const labels = [...document.querySelectorAll(".pp-heading")].map((h) => h.textContent);
    // The ~/projects folder is also a T3 project: it is listed once, under T3 projects.
    expect(labels).toEqual(["T3 projects"]);
    expect(screen.getAllByRole("option", { hidden: true }).at(-1)?.textContent).toBe(
      "Type a path…",
    );
    pick("Folder: none", "Foo");
    expect(chip("Folder: /home/u/projects/foo").title).toBe("/home/u/projects/foo");
  });

  it("falls back to a Folder chip with the error when T3 cannot be read", async () => {
    server.t3Projects = null;
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    expect(await screen.findByText(/Could not list T3 projects/)).toBeTruthy();
    pick("Folder: none", "foo");
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toMatchObject({
      provider: "t3",
      project: "/home/u/projects/foo",
    });
  });

  it("is accessible with the composer filled", async () => {
    await openDialog();
    type(/^First message/, "Do the thing");
    await expectAccessible();
  });
});

describe("+ New topic", () => {
  it("opens from the button with the title focused, and is accessible", async () => {
    const dialog = await openDialog();
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(field("Title"));
    expect(screen.getByRole("button", { name: "Create topic" })).toBeTruthy();
    await waitFor(() => expect(chip("Project: none")).toBeTruthy());
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
    expect(await screen.findByText(/Choose the T3 project/)).toBeTruthy();
    expect(server.called("POST", "/api/topics")).toHaveLength(0);
    expect(document.activeElement).toBe(chip("Project: none"));
  });

  it("creates the topic only, with goal, parent and folder", async () => {
    server.epics = [
      { id: 1, slug: "e1", title: "Big epic", ticketCount: 0, topicCount: 0 },
    ] as never;
    await openDialog();
    await screen.findByRole("option", { name: "Big epic" });
    type("Title", "Fix it");
    type(/^Goal/, "Be done");
    pick("Project: none", "Foo");
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
    pick("Project: none", "Foo");
    type(/^First message/, "Do the thing");
    expect(
      screen.getByRole("button", { name: "Create and start", description: /Ctrl\+Enter/ }),
    ).toBeTruthy();
    expect(chip(/^Effort/).getAttribute("aria-disabled")).toBe("true");
    expect(chip(/^Effort/).title).toMatch(/Choose a model first/);
    pick("Model: default", "claude-opus-5-5");
    pick("Effort: default", "high");
    expect(screen.getByText(/claudeAgent/)).toBeTruthy();
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics")).toHaveLength(1);
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toEqual({
      text: "Do the thing",
      provider: "t3",
      project: "proj-foo",
      providerInstance: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "high",
    });
  });

  it("starts a Claude Code thread with cwd and no provider instance", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    pick("Provider: T3", "Claude Code");
    pick("Folder: none", "Foo");
    pick("Model: default", "claude-sonnet-5-5");
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toEqual({
      text: "Do the thing",
      provider: "claude-code",
      cwd: "/home/u/projects/foo",
      model: "claude-sonnet-5-5",
    });
  });

  it("types a folder path for Claude Code with Type a path…", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    pick("Provider: T3", "Claude Code");
    expect(screen.queryByRole("textbox", { name: "Folder" })).toBeNull();
    pick("Folder: none", "Type a path");
    fireEvent.change(screen.getByRole("textbox", { name: "Folder" }), {
      target: { value: "/tmp/elsewhere" },
    });
    expect(chip("Folder: /tmp/elsewhere").textContent).toContain("elsewhere");
    submit();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics/fix-it/threads/new")[0]?.body).toEqual({
      text: "Do the thing",
      provider: "claude-code",
      cwd: "/tmp/elsewhere",
    });
  });

  it("enables the send icon only when the form is valid with a message", async () => {
    await openDialog();
    expect(send().hasAttribute("disabled")).toBe(true);
    type(/^First message/, "Do the thing");
    expect((send() as HTMLButtonElement).title).toMatch(/title/);
    type("Title", "Fix it");
    expect((send() as HTMLButtonElement).title).toMatch(/Choose a T3 project/);
    expect(send().hasAttribute("disabled")).toBe(true);
    pick("Project: none", "Foo");
    expect(send().hasAttribute("disabled")).toBe(false);
    fireEvent.click(send());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.called("POST", "/api/topics/fix-it/threads/new")).toHaveLength(1);
  });

  it("changes the footer to Create and start when there is a message", async () => {
    await openDialog();
    const footer = () => document.querySelector(".nt-actions") as HTMLElement;
    expect(within(footer()).getByRole("button", { name: "Create topic" })).toBeTruthy();
    type(/^First message/, "Do the thing");
    expect(within(footer()).getByRole("button", { name: "Create and start" })).toBeTruthy();
    type(/^First message/, "");
    expect(within(footer()).getByRole("button", { name: "Create topic" })).toBeTruthy();
  });

  it("submits with Ctrl+Enter from the message", async () => {
    await openDialog();
    type("Title", "Fix it");
    type(/^First message/, "Do the thing");
    pick("Project: none", "Foo");
    fireEvent.keyDown(field(/^First message/), { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(server.called("POST", "/api/topics/fix-it/threads/new")).toHaveLength(1),
    );
  });

  it("keeps the dialog on a start failure and retries without creating a second topic", async () => {
    server.newThreadFails = 1;
    await openDialog();
    type("Title", "Fix it");
    pick("Project: none", "Foo");
    type(/^First message/, "Do the thing");
    submit();
    const alert = await screen.findByText(/did not start: .*exited with 1/);
    expect(alert).toBeTruthy();
    // The error sits inside the composer box, and the send icon retries.
    expect(alert.closest(".rc-box")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    const retry = within(document.querySelector(".nt-actions") as HTMLElement).getByRole("button", {
      name: "Retry start",
    });
    expect(send().getAttribute("aria-label")).toBe("Retry start");
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
