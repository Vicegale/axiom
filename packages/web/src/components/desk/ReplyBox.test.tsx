import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
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
  runtime: null,
  subagents: [],
  hasReply: false,
  pendingRequests: 0,
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

function Harness({
  thread,
  threads,
  startOpen,
  onSent,
}: {
  thread: DeskThread | null;
  threads: DeskThread[];
  startOpen: boolean;
  onSent: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <ReplyBox
      topicSlug="demo"
      thread={thread}
      threads={threads}
      open={open}
      onOpenChange={setOpen}
      onSent={onSent}
    />
  );
}

const setup = (thread: DeskThread | null = T3, threads = [T3, CC], startOpen = true) => {
  const onSent = vi.fn();
  render(<Harness thread={thread} threads={threads} startOpen={startOpen} onSent={onSent} />);
  return { onSent };
};
const bar = () => screen.getByRole("button", { name: /^(Reply to|Start a thread)/ });
const box = () => screen.getByRole("textbox", { name: /^Message to/ }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const send = () =>
  screen.getByRole("button", { name: /^(Send to|Start a new thread)/ }) as HTMLButtonElement;
const posts = () => calls.filter((c) => c.method === "POST");
const chip = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const pick = (chipName: RegExp | string, option: string) => {
  fireEvent.click(chip(chipName));
  const re = new RegExp(`^${option}`);
  fireEvent.click(
    screen.queryByRole("menuitemradio", { name: re, hidden: true }) ??
      screen.getByRole("option", { name: re, hidden: true }),
  );
};
const menuOf = (name: string) => screen.getByRole("menu", { name, hidden: true });

describe("ReplyBox collapsed", () => {
  it("is a single bar naming the thread, with the box hidden", () => {
    setup(T3, [T3, CC], false);
    expect(bar().getAttribute("aria-expanded")).toBe("false");
    expect(bar().textContent).toContain("Reply to Fix the importer…");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says 'Start a thread…' when the topic has none", () => {
    setup(null, [], false);
    expect(bar().textContent).toContain("Start a thread…");
  });

  it("expands on click and focuses the text", () => {
    setup(T3, [T3, CC], false);
    fireEvent.click(bar());
    expect(document.activeElement).toBe(box());
    expect(screen.queryByRole("button", { name: /^Reply to/ })).toBeNull();
  });

  it("shows a one-line preview of the draft with a Draft tag", () => {
    localStorage.setItem("axiom.reply-draft:demo:1", "first line\nsecond line");
    setup(T3, [T3, CC], false);
    expect(bar().textContent).toContain("Draft");
    expect(bar().textContent).toContain("first line");
    expect(bar().textContent).not.toContain("second line");
    expect(bar().getAttribute("aria-label")).toContain("draft");
  });
});

describe("ReplyBox", () => {
  it("focuses the textarea, labels it by target, and loads the options", async () => {
    setup();
    expect(document.activeElement).toBe(box());
    expect(box().getAttribute("aria-label")).toBe("Message to Fix the importer");
    expect(chip(/^Thread: Fix the importer/)).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.path === "/api/compose/options")).toBe(true));
  });

  it("sends to the selected T3 thread without model or effort, clears, and collapses", async () => {
    const { onSent } = setup();
    type("  Please continue  ");
    fireEvent.click(send());
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(posts()).toEqual([
      { method: "POST", path: "/api/threads/1/send", body: { text: "Please continue" } },
    ]);
    expect(localStorage.getItem("axiom.reply-draft:demo:1")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(bar().textContent).not.toContain("Draft");
    expect(document.activeElement).toBe(bar());
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

  it("disables Send while the box is empty, and ignores the shortcut", () => {
    setup();
    expect(send().disabled).toBe(true);
    expect(send().className).not.toContain("ready");
    type("   ");
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    expect(posts()).toHaveLength(0);
    type("hi");
    expect(send().disabled).toBe(false);
    expect(send().className).toContain("ready");
  });

  it("disables the model and effort chips for an existing T3 thread, with the reason", () => {
    setup(T3);
    for (const name of [/^Model:/, /^Effort:/]) {
      expect(chip(name).getAttribute("aria-disabled")).toBe("true");
      expect(chip(name).title).toMatch(/cannot change the model or effort/);
      expect(chip(name).getAttribute("popovertarget")).toBeNull();
    }
    expect(screen.getAllByText(/cannot change the model or effort/)[0]?.className).toContain(
      "sr-only",
    );
  });

  it("chips open menus whose items change the value", async () => {
    const { onSent } = setup(CC);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await screen.findByRole("menuitemradio", { name: "claude-sonnet-5-5", hidden: true });
    expect(chip("Model: default").getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(chip("Model: default"));
    expect(menuOf("Model").matches(":popover-open")).toBe(true);
    pick("Model: default", "claude-sonnet-5-5");
    expect(chip("Model: claude-sonnet-5-5")).toBeTruthy();
    pick("Effort: default", "max");
    expect(chip("Effort: max").textContent).toContain("max");
    type("go");
    fireEvent.click(send());
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(posts()[0]).toEqual({
      method: "POST",
      path: "/api/threads/2/send",
      body: { text: "go", model: "claude-sonnet-5-5", effort: "max" },
    });
  });

  it("a menu moves with the arrow keys and Escape closes it without collapsing the box", async () => {
    setup(CC);
    await screen.findByRole("menuitemradio", { name: "claude-sonnet-5-5", hidden: true });
    chip("Model: default").focus();
    fireEvent.click(chip("Model: default"));
    const items = within(menuOf("Model")).getAllByRole("menuitemradio", { hidden: true });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menuOf("Model"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menuOf("Model"), { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));
    const menu = menuOf("Model");
    fireEvent.keyDown(menu, { key: "Escape" });
    if (menu.matches(":popover-open")) menu.hidePopover();
    expect(document.activeElement).toBe(chip("Model: default"));
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("switches the target thread from the target chip", async () => {
    setup(T3);
    pick(/^Thread:/, "Write the docs");
    expect(chip(/^Thread: Write the docs/)).toBeTruthy();
    expect(box().getAttribute("aria-label")).toBe("Message to Write the docs");
    type("x");
    fireEvent.click(send());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.path).toBe("/api/threads/2/send");
  });

  it("shows where the message goes, and switches back to the same thread", async () => {
    setup(T3);
    expect(chip("This thread").getAttribute("aria-pressed")).toBe("true");
    expect(chip("New thread").getAttribute("aria-pressed")).toBe("false");
    pick(/^Thread:/, "Write the docs");
    fireEvent.click(chip("New thread"));
    expect(chip("New thread").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /^Thread:/ })).toBeNull();
    fireEvent.click(chip("This thread"));
    expect(chip(/^Thread: Write the docs/)).toBeTruthy();
    expect(box().getAttribute("aria-label")).toBe("Message to Write the docs");
  });

  it("has no thread chip when the topic has a single thread", () => {
    setup(T3, [T3]);
    expect(chip("This thread").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /^Thread:/ })).toBeNull();
  });

  it("New thread turns Send into Start thread, with a provider chip", async () => {
    const { onSent } = setup(T3);
    expect(screen.queryByRole("button", { name: /^Provider:/ })).toBeNull();
    fireEvent.click(chip("New thread"));
    expect(send().getAttribute("aria-label")).toBe("Start a new thread");
    expect(box().getAttribute("aria-label")).toBe("Message to a new thread");
    expect(chip("Provider: T3")).toBeTruthy();
    pick("Provider: T3", "Claude Code");
    await screen.findByRole("menuitemradio", { name: "claude-opus-5-5", hidden: true });
    pick("Effort: default", "low");
    type("Start fresh");
    fireEvent.click(send());
    await waitFor(() => expect(onSent).toHaveBeenCalled());
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
    fireEvent.click(chip("New thread"));
    await screen.findByText(/Could not list T3 projects/);
    expect(chip(/^Model:/).getAttribute("aria-disabled")).toBe("true");
    expect(chip(/^Model:/).title).toMatch(/new T3 thread uses the project's default/);
    type("Hello");
    fireEvent.click(send());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.body).toEqual({ text: "Hello", provider: "t3" });
  });

  it("works with no thread: it starts one, and This thread says why it is off", async () => {
    setup(null, []);
    type("x");
    expect(send().getAttribute("aria-label")).toBe("Start a new thread");
    await waitFor(() => expect(send().disabled).toBe(false));
    expect(chip("This thread").disabled).toBe(true);
    expect(chip("This thread").title).toBe("This topic has no thread yet.");
    expect(chip("New thread").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("axiom.reply-draft:demo:new")).toBe("x");
  });

  it("keeps the draft per topic and thread, across a remount", () => {
    setup(T3);
    type("draft one");
    expect(localStorage.getItem("axiom.reply-draft:demo:1")).toBe("draft one");
    pick(/^Thread:/, "Write the docs");
    expect(box().value).toBe("");
    type("draft two");
    pick(/^Thread:/, "Fix the importer");
    expect(box().value).toBe("draft one");
    cleanup();
    setup(CC);
    expect(box().value).toBe("draft two");
  });

  it("keeps the draft when sending fails and shows the error inside the box", async () => {
    respond = (method, path) =>
      path === "/api/compose/options"
        ? json(OPTIONS)
        : method === "POST"
          ? json(
              { error: { code: "provider", message: "t3 thread send exited with 1: boom" } },
              502,
            )
          : json({}, 404);
    const { onSent } = setup();
    type("keep me");
    fireEvent.click(send());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
    expect(screen.getByRole("form", { name: "Reply" }).contains(alert)).toBe(true);
    expect(onSent).not.toHaveBeenCalled();
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
    fireEvent.click(send());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("open in a terminal");
    expect(screen.getByText("cd '/w' && claude --resume s-2")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    });
    expect(writeText).toHaveBeenCalledWith("cd '/w' && claude --resume s-2");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("shows a sending state and disables Send meanwhile", async () => {
    let release: (r: Response) => void = () => {};
    respond = (method, path) => {
      if (path === "/api/compose/options") return json(OPTIONS);
      if (method === "POST")
        return new Promise<Response>((r) => (release = r)) as unknown as Response;
      return json({}, 404);
    };
    setup();
    type("slow");
    fireEvent.click(send());
    const busy = await screen.findByRole("button", { name: "Sending…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    await act(async () => release(json({ ok: true })));
  });

  it("works when localStorage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { onSent } = setup();
    type("hello");
    fireEvent.click(send());
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    spy.mockRestore();
  });

  it("the Collapse button keeps the draft, which shows in the bar", () => {
    setup();
    type("later");
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(localStorage.getItem("axiom.reply-draft:demo:1")).toBe("later");
    expect(bar().textContent).toContain("later");
    expect(document.activeElement).toBe(bar());
  });

  it("Escape collapses when empty, and with text it collapses but keeps the draft", () => {
    setup();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(bar());
    type("half-written");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(bar().textContent).toContain("half-written");
    fireEvent.click(bar());
    expect(box().value).toBe("half-written");
  });

  it("a draft survives a refresh: it is in the collapsed bar of a fresh mount", () => {
    setup();
    type("persist");
    cleanup();
    setup(T3, [T3, CC], false);
    expect(bar().textContent).toContain("persist");
  });

  describe("a new T3 thread's project", () => {
    const P = (id: string, root: string, hasDefaultModel = true) => ({
      id,
      title: `Title ${id}`,
      workspaceRoot: root,
      hasDefaultModel,
      pinned: false,
    });
    let projects: ReturnType<typeof P>[];
    beforeEach(() => {
      projects = [P("p1", "/work/one"), P("p2", "/work/two", false)];
      const base = respond;
      respond = (method, path) =>
        path === "/api/t3/projects" ? json(projects) : base(method, path);
    });
    const setupNew = (repository: string | null, thread: DeskThread | null = null) => {
      render(<ReplyBoxHarness thread={thread} repository={repository} />);
    };

    it("shows a Project chip only for a new T3 thread", async () => {
      setupNew("/work/one", T3);
      expect(screen.queryByRole("button", { name: /^Project:/ })).toBeNull();
      fireEvent.click(chip("New thread"));
      await screen.findByRole("button", { name: /^Project:/ });
      pick(/^Provider:/, "Claude Code");
      expect(screen.queryByRole("button", { name: /^Project:/ })).toBeNull();
    });

    it("defaults to the project containing the repository link and sends its id", async () => {
      setupNew("/work/one/sub/dir");
      const c = await screen.findByRole("button", { name: /^Project:/ });
      expect(c.textContent).toContain("Title p1");
      type("Hello");
      fireEvent.click(send());
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).toEqual({ text: "Hello", provider: "t3", project: "p1" });
    });

    it("has no project and a disabled Send when the repository matches none", async () => {
      setupNew("/home/me/project/axiom");
      await screen.findByRole("button", { name: /^Project:/ });
      type("Hello");
      expect(send().disabled).toBe(true);
      expect(send().title).toBe("Choose a T3 project");
      pick(/^Project:/, "Title p1");
      expect(send().disabled).toBe(false);
    });

    it("requires a model when the project has no default, sent on claudeAgent", async () => {
      setupNew("/work/two");
      await screen.findByRole("button", { name: /^Project:/ });
      type("Hello");
      expect(send().disabled).toBe(true);
      expect(send().title).toBe("Choose a model; this project has no default");
      expect(chip(/^Effort:/).getAttribute("aria-disabled")).toBe("true");
      pick(/^Model:/, "claude-opus-5-5");
      expect(send().disabled).toBe(false);
      pick(/^Effort:/, "high");
      fireEvent.click(send());
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).toEqual({
        text: "Hello",
        provider: "t3",
        project: "p2",
        model: "claude-opus-5-5",
        providerInstance: "claudeAgent",
        effort: "high",
      });
    });

    it("shows why projects are missing and falls back to the old behaviour", async () => {
      respond = (method, path) =>
        path === "/api/t3/projects"
          ? json({ error: { code: "unavailable", message: "T3 cannot be read: gone" } }, 503)
          : method === "POST"
            ? json({ ok: true })
            : json(OPTIONS);
      setupNew("/work/one");
      await screen.findByText(/T3 cannot be read: gone/);
      expect(screen.queryByRole("button", { name: /^Project:/ })).toBeNull();
      type("Hello");
      fireEvent.click(send());
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.body).toEqual({ text: "Hello", provider: "t3" });
    });
  });
});

function ReplyBoxHarness({
  thread,
  repository,
}: {
  thread: DeskThread | null;
  repository: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ReplyBox
      topicSlug="demo"
      thread={thread}
      threads={thread ? [thread] : []}
      repository={repository}
      open={open}
      onOpenChange={setOpen}
      onSent={() => {}}
    />
  );
}
