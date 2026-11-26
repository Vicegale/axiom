import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import { expectAccessible } from "../../test/axe";
import { FakeServer } from "../../test/fakeApi";
import { seedTracker } from "../../test/seed";

let server: FakeServer;

function start(path = "/steward") {
  render(<App router={{ hook: memoryLocation({ path }).hook }} />);
}

beforeEach(() => {
  server = new FakeServer();
  seedTracker(server);
  server.install();
  server.settings.steward.enabled = true;
  server.steward.enabled = true;
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const chatButton = () => screen.findByRole("button", { name: "Chat" });
const openChat = async () => {
  fireEvent.click(await chatButton());
  return screen.findByRole("complementary", { name: "Chat with Steward" });
};
const click = (el: HTMLElement) => fireEvent.click(el);
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const enter = (el: HTMLElement) => fireEvent.keyDown(el, { key: "Enter" });
const esc = () => fireEvent.keyDown(document, { key: "Escape" });

describe("the Steward chat drawer", () => {
  it.each(["/steward", "/desk"])(
    "opens from the top bar of %s and focuses the composer",
    async (path) => {
      start(path);
      const button = await chatButton();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      const drawer = await openChat();
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(within(drawer).getByRole("heading", { name: "Chat" })).toBeTruthy();
      expect(document.activeElement).toBe(
        within(drawer).getByRole("textbox", { name: "Message Steward" }),
      );
    },
  );

  it("closes on Escape and on Close, returning focus to the Chat button", async () => {
    start();
    const button = await chatButton();
    await openChat();
    esc();
    expect(screen.queryByRole("complementary", { name: "Chat with Steward" })).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await openChat();
    click(screen.getByRole("button", { name: "Close chat" }));
    expect(screen.queryByRole("complementary", { name: "Chat with Steward" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("sends with Enter, keeps Shift+Enter for a newline, and shows the reply with a Noted line", async () => {
    server.chatReply = {
      text: "Noted: **Friday**.",
      meta: {
        noted: [
          { where: "topic", topic: "alpha", change: "note", text: "Launch moved to Friday." },
          { where: "memory", memoryItemId: 3, text: "Reviews PRs before lunch." },
        ],
        actions: [{ kind: "check topic", topic: "alpha", started: true }],
      },
    };
    start();
    const drawer = await openChat();
    const box = within(drawer).getByRole("textbox", { name: "Message Steward" });
    type(box, "line one\nline two");
    // Shift+Enter is a newline: it is not sent
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(server.called("POST", "/api/steward/chat")).toHaveLength(0);
    enter(box);
    expect(await within(drawer).findByText("Friday")).toBeTruthy();
    expect(within(drawer).getByText(/line one/)).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("");
    // a chat was started with the default model, then the message sent with it
    expect(server.called("POST", "/api/steward/chat")[0]?.body).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    expect(server.called("POST", "/api/steward/chat/1/messages")[0]?.body).toEqual({
      text: "line one\nline two",
      model: "sonnet",
      effort: "medium",
    });
    const notes = drawer.querySelectorAll(".st-noted");
    expect(notes).toHaveLength(2);
    expect(notes[0]?.textContent).toContain("Noted");
    expect(notes[0]?.textContent).toContain("Launch moved to Friday.");
    expect(notes[0]?.textContent).toContain("→ alpha");
    expect(notes[1]?.textContent).toContain("→ memory");
    expect(within(drawer).getByText("Started a check of alpha")).toBeTruthy();
    // the log announces new replies politely
    expect(within(drawer).getByRole("log").getAttribute("aria-live")).toBe("polite");
    await expectAccessible(drawer);
  });

  it("shows a running indicator until the reply arrives", async () => {
    server.chatHold = true;
    start();
    const drawer = await openChat();
    type(within(drawer).getByRole("textbox"), "hello");
    enter(within(drawer).getByRole("textbox"));
    expect((await within(drawer).findByRole("status")).textContent).toContain("working");
    expect(
      (within(drawer).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => server.finishChat());
    expect(await within(drawer).findByText("All quiet.", {}, { timeout: 5000 })).toBeTruthy();
    expect(within(drawer).queryByRole("status")).toBeNull();
  }, 10_000);

  it("shows why a turn failed and retries it", async () => {
    server.chatFail = "daily token cap reached for sonnet: 100 of 100 tokens used today";
    start();
    const drawer = await openChat();
    type(within(drawer).getByRole("textbox"), "hello");
    enter(within(drawer).getByRole("textbox"));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toMatch(/daily token cap reached for sonnet/);
    click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(drawer).findByText("All quiet.")).toBeTruthy();
    expect(within(drawer).queryByRole("alert")).toBeNull();
    expect(server.called("POST", "/api/steward/chat/1/retry")).toHaveLength(1);
  });

  it("picks the model and effort, remembers them per browser, and sends them", async () => {
    start();
    let drawer = await openChat();
    click(within(drawer).getByRole("button", { name: "Model: sonnet" }));
    click(await screen.findByRole("menuitemradio", { name: /Opus/ }));
    click(within(drawer).getByRole("button", { name: "Effort: medium" }));
    click(await screen.findByRole("menuitemradio", { name: "Low" }));
    expect(within(drawer).getByRole("button", { name: "Model: opus" }).textContent).toContain(
      "Opus",
    );
    expect(window.localStorage.getItem("axiom.steward.chat.model")).toBe("opus");
    type(within(drawer).getByRole("textbox"), "hi");
    enter(within(drawer).getByRole("textbox"));
    await within(drawer).findByText("All quiet.");
    expect(server.called("POST", "/api/steward/chat/1/messages")[0]?.body).toMatchObject({
      model: "opus",
      effort: "low",
    });
    // a new visit starts with the remembered choice
    esc();
    drawer = await openChat();
    expect(within(drawer).getByRole("button", { name: "Model: opus" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Effort: low" })).toBeTruthy();
  });

  it("shows the current chat when reopened, and starts another with New", async () => {
    start();
    let drawer = await openChat();
    type(within(drawer).getByRole("textbox"), "first");
    enter(within(drawer).getByRole("textbox"));
    await within(drawer).findByText("All quiet.");
    esc();
    drawer = await openChat();
    expect(await within(drawer).findByText("All quiet.")).toBeTruthy();
    click(within(drawer).getByRole("button", { name: "New" }));
    expect(within(drawer).queryByText("All quiet.")).toBeNull();
    expect(document.activeElement).toBe(within(drawer).getByRole("textbox"));
    type(within(drawer).getByRole("textbox"), "second");
    enter(within(drawer).getByRole("textbox"));
    await waitFor(() => expect(server.called("POST", "/api/steward/chat")).toHaveLength(2));
    expect(await within(drawer).findByText("second")).toBeTruthy();
    expect(within(drawer).queryByText("first")).toBeNull();
  });

  it("does not send an empty message", async () => {
    start();
    const drawer = await openChat();
    const send = within(drawer).getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    enter(within(drawer).getByRole("textbox"));
    expect(server.called("POST", "/api/steward/chat")).toHaveLength(0);
  });
});
