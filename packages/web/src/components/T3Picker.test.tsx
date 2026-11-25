import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { T3Thread } from "../api";
import { T3Picker } from "./T3Picker";

const NOW = new Date("2026-11-25T12:00:00Z");
const THREADS: T3Thread[] = [
  {
    id: "th-1",
    title: "Fix the importer",
    environmentId: "env-1",
    status: "running",
    updatedAt: "2026-11-25T11:00:00Z",
  },
  {
    id: "th-2",
    title: "Write the docs",
    environmentId: "env-1",
    status: "idle",
    updatedAt: "2026-11-24T11:00:00Z",
  },
];

let calls: { method: string; path: string; body?: unknown }[];
let respond: (method: string, path: string) => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  respond = (method, path) => {
    if (method === "GET" && path === "/api/t3/threads?unattached=1") return json(THREADS);
    if (method === "POST" && path === "/api/topics/demo/threads") return json({ id: 1 }, 201);
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
afterEach(() => vi.unstubAllGlobals());

const openPicker = async () => {
  render(<T3Picker slug="demo" now={NOW} />);
  fireEvent.click(screen.getByRole("button", { name: "Attach T3 thread" }));
  await screen.findByText("Fix the importer");
};

describe("T3Picker", () => {
  it("is closed until the button is pressed, then lists the unattached threads", async () => {
    render(<T3Picker slug="demo" now={NOW} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Attach T3 thread" }));
    await screen.findByText("Fix the importer");
    expect(screen.getByRole("dialog", { name: "Attach a T3 thread" })).toBeTruthy();
    expect(screen.getByText("Write the docs")).toBeTruthy();
    expect(screen.getByText("th-1")).toBeTruthy();
    expect(screen.getByText("updated 1 h ago")).toBeTruthy();
  });

  it("filters the list by title as you type", async () => {
    await openPicker();
    fireEvent.change(screen.getByLabelText("Search T3 threads"), { target: { value: "DOCS" } });
    expect(screen.queryByText("Fix the importer")).toBeNull();
    expect(screen.getByText("Write the docs")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search T3 threads"), { target: { value: "zzz" } });
    expect(screen.getByText("No threads match.")).toBeTruthy();
  });

  it("attaches the chosen thread with provider t3 and closes", async () => {
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Attach Fix the importer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST");
    expect(post).toEqual({
      method: "POST",
      path: "/api/topics/demo/threads",
      body: {
        provider: "t3",
        providerThreadId: "th-1",
        environmentId: "env-1",
        title: "Fix the importer",
      },
    });
  });

  it("shows the server's message and stays open when attaching fails", async () => {
    respond = (method) =>
      method === "POST"
        ? json({ error: { code: "conflict", message: "already attached" } }, 409)
        : json(THREADS);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Attach Write the docs" }));
    expect((await screen.findByRole("alert")).textContent).toBe("already attached");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says so when every thread is attached, and when T3 cannot be read", async () => {
    respond = () => json([]);
    render(<T3Picker slug="demo" now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach T3 thread" }));
    await screen.findByText("Every T3 thread is attached.");
    cleanup();

    respond = () =>
      json({ error: { code: "unavailable", message: "T3 cannot be read: gone" } }, 503);
    render(<T3Picker slug="demo" now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach T3 thread" }));
    expect((await screen.findByRole("alert")).textContent).toBe("T3 cannot be read: gone");
  });

  it("closes on Escape", async () => {
    await openPicker();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
