import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeOptions, DeskThread } from "../../api";
import { ReplyBox } from "./ReplyBox";

const OPTIONS: ComposeOptions = {
  source: "static",
  providers: {
    t3: { models: ["claude-opus-5-5"], efforts: ["low", "high"] },
    "claude-code": {
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      efforts: ["low", "high", "max"],
    },
  },
};

const mk = (over: Partial<DeskThread>): DeskThread => ({
  id: 1,
  provider: "t3",
  providerThreadId: "th-1",
  title: "Fix the importer",
  status: "idle",
  open: true,
  startedAt: "2026-11-25T10:00:00Z",
  endedAt: null,
  lastReplyAt: null,
  summary: null,
  summaryError: null,
  activity: null,
  hasReply: false,
  ...over,
});
const T3 = mk({});
const CC = mk({ id: 2, provider: "claude-code", providerThreadId: "s-2", title: "Write the docs" });

let calls: { method: string; path: string; body?: unknown }[];
let respond: (method: string, path: string) => Response;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  calls = [];
  respond = (method, path) => {
    if (path === "/api/compose/options") return json(OPTIONS);
    if (method === "POST") return json({ ok: true });
    return json({ error: { code: "not-found", message: "unmocked" } }, 404);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path: input,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return respond(method, input);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setup = (thread: DeskThread | null = T3, threads = [T3, CC]) => {
  const onSent = vi.fn();
  const onClose = vi.fn();
  render(
    <ReplyBox
      topicSlug="demo"
      thread={thread}
      threads={threads}
      onSent={onSent}
      onClose={onClose}
    />,
  );
  return { onSent, onClose };
};
const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const posts = () => calls.filter((c) => c.method === "POST");

describe("ReplyBox", () => {
  it("focuses the textarea and names the target", async () => {
    setup();
    expect(document.activeElement).toBe(box());
    expect(screen.getByText("Fix the importer")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/compose/options")).toBe(true));
  });

  it("sends to the selected T3 thread without model or effort, clears, and closes", async () => {
    const { onSent, onClose } = setup();
    type("  Please continue  ");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(posts()).toEqual([
      { method: "POST", path: "/api/threads/1/send", body: { text: "Please continue" } },
    ]);
    expect(localStorage.getItem("axiom.reply-draft:demo:1")).toBeNull();
  });

  it("Ctrl+Enter and Cmd+Enter send", async () => {
    const { onSent } = setup();
    type("a");
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    cleanup();
    const second = setup();
    type("b");
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(second.onSent).toHaveBeenCalled());
    expect(posts()).toHaveLength(2);
  });

  it("does not send an empty message", () => {
    setup();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New thread" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    type("   ");
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    expect(posts()).toHaveLength(0);
  });

  it("disables model and effort for an existing T3 thread, with a hint", () => {
    setup(T3);
    // the new-thread provider follows the thread (T3), so the picker is off
    expect((screen.getByLabelText("Model") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Effort") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/cannot change the model or effort/)).toBeTruthy();
  });

  it("sends model and effort to a Claude Code thread", async () => {
    const { onSent } = setup(CC);
    await screen.findByRole("option", { name: "claude-sonnet-5-5" });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5-5" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "max" } });
    type("go");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(posts()[0]).toEqual({
      method: "POST",
      path: "/api/threads/2/send",
      body: { text: "go", model: "claude-sonnet-5-5", effort: "max" },
    });
  });

  it("switches the target thread", async () => {
    setup(T3);
    fireEvent.change(screen.getByLabelText("Thread"), { target: { value: "2" } });
    expect(screen.getByText("Write the docs")).toBeTruthy();
    type("x");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.path).toBe("/api/threads/2/send");
  });

  it("starts a new thread with the chosen provider", async () => {
    const { onSent, onClose } = setup(T3);
    fireEvent.change(screen.getByLabelText("New thread with"), {
      target: { value: "claude-code" },
    });
    await screen.findByRole("option", { name: "claude-opus-5-5" });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "low" } });
    type("Start fresh");
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(posts()).toEqual([
      {
        method: "POST",
        path: "/api/topics/demo/threads/new",
        body: { text: "Start fresh", provider: "claude-code", effort: "low" },
      },
    ]);
  });

  it("starts a new T3 thread without model or effort", async () => {
    setup(T3);
    type("Hello");
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toEqual({ text: "Hello", provider: "t3" });
  });

  it("works with no thread: only New thread can send", () => {
    setup(null, []);
    type("x");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New thread" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText(/no thread yet/)).toBeTruthy();
  });

  it("keeps the draft per topic and thread, across a remount", () => {
    setup(T3);
    type("draft one");
    expect(localStorage.getItem("axiom.reply-draft:demo:1")).toBe("draft one");
    fireEvent.change(screen.getByLabelText("Thread"), { target: { value: "2" } });
    expect(box().value).toBe("");
    type("draft two");
    fireEvent.change(screen.getByLabelText("Thread"), { target: { value: "1" } });
    expect(box().value).toBe("draft one");
    cleanup();
    setup(CC);
    expect(box().value).toBe("draft two");
  });

  it("keeps the draft when sending fails and shows the error", async () => {
    respond = (method, path) =>
      path === "/api/compose/options"
        ? json(OPTIONS)
        : method === "POST"
          ? json(
              { error: { code: "provider", message: "t3 thread send exited with 1: boom" } },
              502,
            )
          : json({}, 404);
    const { onSent, onClose } = setup();
    type("keep me");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(onSent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(box().value).toBe("keep me");
    expect(localStorage.getItem("axiom.reply-draft:demo:1")).toBe("keep me");
  });

  it("shows the resume command with a copy button on a 409", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    respond = (_method, path) =>
      path === "/api/compose/options"
        ? json(OPTIONS)
        : json(
            {
              error: {
                code: "conflict",
                message: "This session is open in a terminal; reply there or close it first.",
                resumeCommand: "cd '/w' && claude --resume s-2",
              },
            },
            409,
          );
    setup(CC);
    type("hi");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("open in a terminal");
    expect(screen.getByText("cd '/w' && claude --resume s-2")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    });
    expect(writeText).toHaveBeenCalledWith("cd '/w' && claude --resume s-2");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("shows a sending state and disables the buttons meanwhile", async () => {
    let release: (r: Response) => void = () => {};
    respond = (method, path) => {
      if (path === "/api/compose/options") return json(OPTIONS);
      if (method === "POST")
        return new Promise<Response>((r) => (release = r)) as unknown as Response;
      return json({}, 404);
    };
    setup();
    type("slow");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const busy = await screen.findByRole("button", { name: "Sending…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "New thread" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => release(json({ ok: true })));
  });

  it("works when localStorage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { onSent } = setup();
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    spy.mockRestore();
  });

  it("Close keeps the draft and calls onClose", () => {
    const { onClose } = setup();
    type("later");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem("axiom.reply-draft:demo:1")).toBe("later");
  });
});
