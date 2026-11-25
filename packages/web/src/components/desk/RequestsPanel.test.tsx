import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../../App";
import type { PendingRequest } from "../../api";
import { expectAccessible } from "../../test/axe";
import { deskThread, deskTopic, FakeServer } from "../../test/fakeApi";
import { seedTracker } from "../../test/seed";

let server: FakeServer;

const request = (over: Partial<PendingRequest> & { id: string }): PendingRequest => ({
  provider: "t3",
  kind: "question",
  text: "",
  questions: [],
  tool: null,
  summary: null,
  requestKind: null,
  createdAt: null,
  decidable: false,
  openUrl: null,
  ...over,
});

const WINDOWS = {
  id: "Which windows?",
  header: "Clear panes",
  question: "Which windows should be clear?",
  multiSelect: false,
  options: [
    { label: "Plant cars only", description: "Two a side" },
    { label: "All", description: "Every car" },
  ],
};

function show(threads: Parameters<typeof deskThread>[0][], reqs: [number, PendingRequest[]][]) {
  server.desk = [
    deskTopic({ slug: "alpha", title: "Alpha", status: "hitl", threads: threads.map(deskThread) }),
  ];
  for (const [id, list] of reqs) server.requests.set(id, list);
  const loc = memoryLocation({ path: "/desk" });
  render(<App router={{ hook: loc.hook }} />);
}
const card = () => screen.findByRole("article", { name: "Alpha" });

beforeEach(() => {
  window.localStorage.clear();
  server = new FakeServer();
  seedTracker(server);
  server.install();
});
afterEach(() => vi.unstubAllGlobals());

describe("a card with nothing pending", () => {
  it("does not fetch requests", async () => {
    show([{ id: 1, status: "wip" }], []);
    await card();
    expect(server.calls.some((c) => c.path.includes("/requests"))).toBe(false);
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });
});

describe("a T3 question", () => {
  it("shows the header, the question and its options; choosing one answers at once", async () => {
    show(
      [{ id: 1, status: "hitl", pendingRequests: 1 }],
      [[1, [request({ id: "req-1", questions: [WINDOWS] })]]],
    );
    const a = within(await card());
    const section = await a.findByRole("region", { name: "The agent asked a question" });
    expect(within(section).getByText("Clear panes")).toBeTruthy();
    expect(within(section).getByText("Which windows should be clear?")).toBeTruthy();
    expect(within(section).getByText("Two a side")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: /Plant cars only/ }));
    await waitFor(() =>
      expect(server.called("POST", "/api/threads/1/requests/req-1/answer")[0]?.body).toEqual({
        answers: { "Which windows?": "Plant cars only" },
      }),
    );
    const done = await within(section).findByText("Answered");
    expect(done).toBe(document.activeElement); // focus moves to the status, not lost
    expect(screen.getByRole("status", { name: "Answers sent" }).textContent).toMatch(
      /Answered: Which windows should be clear\?/,
    );
    expect(within(section).queryByRole("button", { name: /Plant cars only/ })).toBeNull();
  });

  it("answers with free text in the Other field", async () => {
    show(
      [{ id: 1, status: "hitl", pendingRequests: 1 }],
      [[1, [request({ id: "req-1", questions: [WINDOWS] })]]],
    );
    const a = within(await card());
    const send = await a.findByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(a.getByLabelText("Other"), { target: { value: "Only the first car" } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(server.called("POST", "/api/threads/1/requests/req-1/answer")[0]?.body).toEqual({
        answers: { "Which windows?": "Only the first car" },
      }),
    );
  });

  it("multi-select: checkboxes, extra text, and Submit sends the list", async () => {
    const multi = { ...WINDOWS, id: "multi", question: "Which cars?", multiSelect: true };
    show(
      [{ id: 1, status: "hitl", pendingRequests: 1 }],
      [[1, [request({ id: "req-2", questions: [multi] })]]],
    );
    const a = within(await card());
    const submit = (await a.findByRole("button", { name: "Submit" })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(a.getByRole("checkbox", { name: /Plant cars only/ }));
    fireEvent.click(a.getByRole("checkbox", { name: /All/ }));
    fireEvent.change(a.getByLabelText("Other"), { target: { value: "and the tender" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(server.called("POST", "/api/threads/1/requests/req-2/answer")[0]?.body).toEqual({
        answers: { multi: ["Plant cars only", "All", "and the tender"] },
      }),
    );
  });

  it("several questions: pick each, then Submit", async () => {
    const second = {
      ...WINDOWS,
      id: "second",
      question: "Which colour?",
      options: [{ label: "Red", description: "" }],
    };
    show(
      [{ id: 1, status: "hitl", pendingRequests: 1 }],
      [[1, [request({ id: "req-3", questions: [WINDOWS, second] })]]],
    );
    const a = within(await card());
    const submit = (await a.findByRole("button", { name: "Submit" })) as HTMLButtonElement;
    const all = a.getByRole("button", { name: /^All/ });
    fireEvent.click(all);
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(submit.disabled).toBe(true); // the second question is open
    fireEvent.click(a.getByRole("button", { name: /^Red/ }));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(server.called("POST", "/api/threads/1/requests/req-3/answer")[0]?.body).toEqual({
        answers: { "Which windows?": "All", second: "Red" },
      }),
    );
  });

  it("shows the server's reason when the answer fails, and keeps the form", async () => {
    server.answerFails = 1;
    show(
      [{ id: 1, status: "hitl", pendingRequests: 1 }],
      [[1, [request({ id: "req-1", questions: [WINDOWS] })]]],
    );
    const a = within(await card());
    fireEvent.click(await a.findByRole("button", { name: /^All/ }));
    expect((await a.findByRole("alert")).textContent).toBe("T3: that request is gone");
    fireEvent.click(a.getByRole("button", { name: /^All/ })); // try again
    expect(await a.findByText("Answered")).toBeTruthy();
  });

  it("is accessible", async () => {
    show(
      [{ id: 1, status: "hitl", pendingRequests: 1 }],
      [
        [
          1,
          [
            request({
              id: "req-1",
              questions: [WINDOWS, { ...WINDOWS, id: "m", multiSelect: true }],
            }),
          ],
        ],
      ],
    );
    await within(await card()).findByRole("region", { name: "The agent asked a question" });
    await expectAccessible();
  });
});

describe("a Claude Code approval", () => {
  const approval = request({
    id: "7",
    provider: "claude-code",
    kind: "approval",
    text: "Bash: $ npm test",
    tool: "Bash",
    summary: "$ npm test",
    decidable: true,
  });

  it("shows the tool and its input; Allow sends the decision", async () => {
    show(
      [{ id: 1, provider: "claude-code", status: "hitl", pendingRequests: 1 }],
      [[1, [approval]]],
    );
    const a = within(await card());
    const section = await a.findByRole("region", { name: "The agent asks permission" });
    expect(within(section).getByText("Bash")).toBeTruthy();
    expect(within(section).getByText("$ npm test")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/approvals/7")[0]?.body).toEqual({ decision: "allow" }),
    );
    expect(await within(section).findByText("Answered")).toBe(document.activeElement);
    expect(screen.getByRole("status", { name: "Answers sent" }).textContent).toMatch(
      /^Allowed: Bash: \$ npm test/,
    );
  });

  it("Deny asks for an optional reason, focuses it, and sends it", async () => {
    show(
      [{ id: 1, provider: "claude-code", status: "hitl", pendingRequests: 1 }],
      [[1, [approval]]],
    );
    const a = within(await card());
    fireEvent.click(await a.findByRole("button", { name: "Deny" }));
    const why = a.getByLabelText("Reason (optional)");
    expect(why).toBe(document.activeElement);
    fireEvent.change(why, { target: { value: "use the script" } });
    fireEvent.click(a.getByRole("button", { name: "Confirm deny" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/approvals/7")[0]?.body).toEqual({
        decision: "deny",
        message: "use the script",
      }),
    );
    expect(screen.getByRole("status", { name: "Answers sent" }).textContent).toMatch(/^Denied:/);
  });

  it("Deny without a reason, and Escape cancels back to the Deny button", async () => {
    show(
      [{ id: 1, provider: "claude-code", status: "hitl", pendingRequests: 1 }],
      [[1, [approval]]],
    );
    const a = within(await card());
    fireEvent.click(await a.findByRole("button", { name: "Deny" }));
    fireEvent.keyDown(a.getByLabelText("Reason (optional)"), { key: "Escape" });
    const deny = a.getByRole("button", { name: "Deny" });
    expect(deny).toBe(document.activeElement);
    fireEvent.click(deny);
    fireEvent.click(a.getByRole("button", { name: "Confirm deny" }));
    await waitFor(() =>
      expect(server.called("POST", "/api/approvals/7")[0]?.body).toEqual({ decision: "deny" }),
    );
  });

  it("is accessible", async () => {
    show(
      [{ id: 1, provider: "claude-code", status: "hitl", pendingRequests: 1 }],
      [[1, [approval]]],
    );
    await within(await card()).findByRole("button", { name: "Allow" });
    await expectAccessible();
  });
});

describe("a T3 approval", () => {
  const t3Approval = request({
    id: "r9",
    kind: "approval",
    text: "Run npm publish?",
    requestKind: "command",
    openUrl: "t3code://threads/env-1/pt-1",
  });

  it("offers Open in T3 (a deep link, with the limitation in its tooltip) and no Allow", async () => {
    show([{ id: 1, status: "hitl", pendingRequests: 1 }], [[1, [t3Approval]]]);
    const a = within(await card());
    const link = await a.findByRole("link", { name: "Open in T3" });
    expect(link.getAttribute("href")).toBe("t3code://threads/env-1/pt-1");
    expect(link.getAttribute("title")).toMatch(/no way to approve one from outside T3/);
    expect(a.getByText("Run npm publish?")).toBeTruthy();
    expect(a.queryByRole("button", { name: "Allow" })).toBeNull();
    await expectAccessible();
  });
});

describe("two requests on one thread", () => {
  it("shows both, and answering one leaves the other open", async () => {
    const cc = (id: string) =>
      request({
        id,
        provider: "claude-code",
        kind: "approval",
        tool: "Bash",
        summary: `$ cmd ${id}`,
        text: id,
        decidable: true,
      });
    show(
      [{ id: 1, provider: "claude-code", status: "hitl", pendingRequests: 2 }],
      [[1, [cc("1"), cc("2")]]],
    );
    const a = within(await card());
    const allows = await a.findAllByRole("button", { name: "Allow" });
    expect(allows).toHaveLength(2);
    fireEvent.click(allows[0] as HTMLElement);
    await a.findByText("Answered");
    expect(a.getAllByRole("button", { name: "Allow" })).toHaveLength(1);
  });
});
