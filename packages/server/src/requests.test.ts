import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Axiom, openDatabase } from "@axiom/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningServer, type StartServerOptions, startServer } from "./index.js";
import { T3Fixture } from "./test-t3.js";

// biome-ignore lint/suspicious/noExplicitAny: test code reads untyped JSON
type Any = any;
const owner: Actor = { kind: "owner" };
const TOKEN = "SECRET-TOKEN-ABC.def";

let dir: string;
let dbPath: string;
let cli: Axiom;
let server: RunningServer | undefined;
let mcp: FakeMcp | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axiom-requests-"));
  dbPath = join(dir, "axiom.db");
  cli = openDatabase(dbPath);
});
afterEach(async () => {
  await server?.close();
  await mcp?.close();
  server = undefined;
  mcp = undefined;
  cli.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Any;
}

/** A fake T3 MCP endpoint: streamable HTTP, JSON-RPC. */
class FakeMcp {
  seen: Seen[] = [];
  /** What `tools/call` answers; override per test. */
  toolReply: () => { status?: number; body: unknown } = () => ({
    body: {
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { sequence: 7 },
        isError: false,
      },
    },
  });
  private server: Server;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d: Buffer) => {
        raw += d.toString();
      });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        this.seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body,
        });
        const json = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
          res.writeHead(status, { "content-type": "application/json", ...extra });
          res.end(payload === undefined ? "" : JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          return json(401, {
            error: "invalid_mcp_credential",
            message: "A valid T3 Code MCP credential is required.",
          });
        }
        if (body?.method === "initialize") {
          return json(
            200,
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "T3 Code", version: "x" },
              },
            },
            { "mcp-session-id": "mcp-session-1" },
          );
        }
        if (body?.method === "tools/call") {
          const r = this.toolReply();
          return json(r.status ?? 200, r.body);
        }
        return json(202, undefined);
      });
    });
  }
  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }
  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
  calls(method: string) {
    return this.seen.filter((s) => s.body?.method === method);
  }
}

/** A fake `t3`: records every call's arguments; `auth session issue` prints a session as JSON. */
function fakeT3(options: { failIssue?: boolean } = {}) {
  const folder = join(dir, "fake-t3");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "t3");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${folder}/calls"
if [ "$1 $2 $3" = "auth session issue" ]; then
  ${options.failIssue ? 'echo "no server running" >&2; exit 1' : `echo '{"sessionId":"sess-1","token":"${TOKEN}","method":"bearer-access-token"}'`}
fi
exit 0
`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    /** The `auth ...` calls (the reply fetcher also calls `t3 thread show` now and then). */
    calls: () =>
      (existsSync(join(folder, "calls"))
        ? readFileSync(join(folder, "calls"), "utf8").trimEnd().split("\n")
        : []
      ).filter((c) => c.startsWith("auth ")),
  };
}

async function start(opts: StartServerOptions = {}) {
  server = await startServer({
    dbPath,
    port: 0,
    webDist: join(dir, "no-web"),
    t3Dir: join(dir, "no-t3"),
    claudeCli: "/nonexistent/claude",
    t3Cli: "/nonexistent/t3",
    ...opts,
  });
}
async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch((server as RunningServer).url + path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as Any };
}

function thread(provider: "claude-code" | "t3", id: string, slug = "demo") {
  if (!cli.listTopics().some((t) => t.slug === slug)) {
    cli.createTopic({ slug, title: `Title ${slug}` }, owner);
  }
  return cli.attachThread(slug, { provider, providerThreadId: id }, owner);
}

const QUESTIONS = [
  {
    id: "Which windows?",
    header: "Clear panes",
    question: "Which windows should be clear?",
    multiSelect: false,
    options: [
      { label: "Plant cars only", description: "Two a side" },
      { label: "All", description: "Every car" },
    ],
  },
  { id: "Notes?", header: "Notes", question: "Anything else?", multiSelect: true, options: [] },
];

/** T3 with one thread that has a pending question and a pending approval. */
function t3WithRequests() {
  const t3 = new T3Fixture(join(dir, "t3"));
  t3.thread("th-1").run("th-1", 1, "waiting");
  const question = t3.request("th-1", "user_input", "Which windows should be clear?", {
    questions: QUESTIONS,
  });
  const approval = t3.request("th-1", "command", "Run npm publish?", { requestKind: "command" });
  return { t3, question, approval };
}

describe("GET /api/threads/:id/requests (T3)", () => {
  it("lists the structured question and the approval with its Open in T3 link", async () => {
    const { t3, question, approval } = t3WithRequests();
    const th = thread("t3", "th-1");
    await start({ t3Dir: t3.dir });
    const r = await api(`/api/threads/${th.id}/requests`);
    expect(r.status).toBe(200);
    expect(r.body.requests).toHaveLength(2);
    expect(r.body.requests[0]).toMatchObject({
      id: question,
      provider: "t3",
      kind: "question",
      decidable: false,
      openUrl: expect.stringMatching(/^t3code:\/\/threads\//),
      questions: QUESTIONS,
    });
    expect(r.body.requests[1]).toMatchObject({
      id: approval,
      kind: "approval",
      text: "Run npm publish?",
      requestKind: "command",
      decidable: false,
      openUrl: "t3code://threads/env-test/th-1",
    });
  });

  it("503s when T3 cannot be read, 400s on a bad id, 404s on an unknown thread", async () => {
    const th = thread("t3", "th-1");
    await start();
    expect((await api(`/api/threads/${th.id}/requests`)).status).toBe(503);
    expect((await api("/api/threads/x/requests")).status).toBe(400);
    expect((await api("/api/threads/999/requests")).status).toBe(404);
  });
});

describe("POST /api/threads/:id/requests/:requestId/answer", () => {
  async function setup() {
    mcp = await new FakeMcp().start();
    const made = t3WithRequests();
    made.t3.setPort(mcp.port);
    const t3cli = fakeT3();
    const th = thread("t3", "th-1");
    await start({ t3Dir: made.t3.dir, t3Cli: t3cli.path });
    return { ...made, t3cli, th };
  }

  it("mints a short-lived token, calls T3's MCP with it, records the answer, never keeps the token", async () => {
    const leaks: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void leaks.push(a.join(" ")));
    }
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
      leaks.push(String(c));
      return true;
    });
    const { question, t3cli, th } = await setup();
    out.mockRestore(); // fetch below goes through vitest's reporter too
    const answers = { "Which windows?": "Plant cars only", "Notes?": ["a", "b"] };
    const r = await api(`/api/threads/${th.id}/requests/${encodeURIComponent(question)}/answer`, {
      method: "POST",
      body: { answers },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    // The token was minted with a 5-minute ttl and revoked afterwards.
    const calls = t3cli.calls();
    expect(calls[0]).toBe(
      "auth session issue --scope orchestration:read --scope orchestration:operate --ttl 5m --label axiom --subject mcp-client --json",
    );
    expect(calls[1]).toBe("auth session revoke sess-1");
    expect(calls).toHaveLength(2);

    // The MCP exchange: initialize, initialized, then the tool call; all with the bearer token.
    const m = (mcp as FakeMcp).seen;
    expect(m.map((s) => s.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    for (const s of m) {
      expect(s.method).toBe("POST");
      expect(s.url).toBe("/mcp");
      expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(s.headers.accept).toContain("application/json");
    }
    expect(m[0]?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { clientInfo: { name: "axiom" } },
    });
    expect(m[2]?.headers["mcp-session-id"]).toBe("mcp-session-1");
    expect(m[2]?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "t3_pending_request",
        arguments: { action: "respond", threadId: "th-1", requestId: question, answers },
      },
    });

    // History: what the owner chose.
    const inputs = cli.listEntries("demo").filter((e) => e.kind === "owner input");
    expect(inputs.map((e) => e.body)).toEqual([
      'Answered "Which windows should be clear?": Plant cars only',
      'Answered "Anything else?": a, b',
    ]);

    // The token is nowhere: not in the response, the logs, or the database files.
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    expect(leaks.join("\n")).not.toContain("SECRET-TOKEN");
    for (const f of readdirSync(dir).filter((n) => n.startsWith("axiom.db"))) {
      expect(readFileSync(join(dir, f)).includes("SECRET-TOKEN")).toBe(false);
    }
  });

  it("asks the T3 sync to refresh", async () => {
    const { question, th } = await setup();
    const before = cli.providerRefreshRequestedAt("t3");
    await new Promise((r) => setTimeout(r, 5));
    await api(`/api/threads/${th.id}/requests/${encodeURIComponent(question)}/answer`, {
      method: "POST",
      body: { answers: { "Which windows?": "All" } },
    });
    expect(cli.providerRefreshRequestedAt("t3")).toBeGreaterThan(before);
  });

  it("502s with T3's reason when the tool fails, and does not log history", async () => {
    const { question, th, t3cli } = await setup();
    (mcp as FakeMcp).toolReply = () => ({
      body: {
        jsonrpc: "2.0",
        id: 2,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "invalid_request",
                message: "That request is not waiting.",
              }),
            },
          ],
        },
      },
    });
    const r = await api(`/api/threads/${th.id}/requests/${encodeURIComponent(question)}/answer`, {
      method: "POST",
      body: { answers: { "Which windows?": "All" } },
    });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatchObject({
      code: "provider",
      message: "T3: That request is not waiting.",
    });
    expect(cli.listEntries("demo").filter((e) => e.kind === "owner input")).toEqual([]);
    expect(t3cli.calls().at(-1)).toBe("auth session revoke sess-1"); // revoked even on failure
  });

  it("409s with a plain message when T3 only lets its own app act on the thread", async () => {
    const { question, th } = await setup();
    (mcp as FakeMcp).toolReply = () => ({
      body: {
        jsonrpc: "2.0",
        id: 2,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "forbidden",
                message:
                  'Thread "x" runs in full-access/default, above this caller\'s approval-required/default limit. Have the user act directly in the target thread through an authorized client.',
              }),
            },
          ],
        },
      },
    });
    const r = await api(`/api/threads/${th.id}/requests/${encodeURIComponent(question)}/answer`, {
      method: "POST",
      body: { answers: { "Which windows?": "All" } },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("t3-limit");
    expect(r.body.error.message).toMatch(/Open it in T3/);
  });

  it("502s when T3 rejects the credential, without echoing the token", async () => {
    const { question, th } = await setup();
    (mcp as FakeMcp).toolReply = () => ({ status: 401, body: { error: `bad ${TOKEN}` } });
    const r = await api(`/api/threads/${th.id}/requests/${encodeURIComponent(question)}/answer`, {
      method: "POST",
      body: { answers: { "Which windows?": "All" } },
    });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toMatch(/refused the request \(401\)/);
    expect(JSON.stringify(r.body)).not.toContain("SECRET-TOKEN");
  });

  it("502s when the t3 binary cannot mint a token, and never calls MCP", async () => {
    mcp = await new FakeMcp().start();
    const made = t3WithRequests();
    made.t3.setPort(mcp.port);
    const th = thread("t3", "th-1");
    await start({ t3Dir: made.t3.dir, t3Cli: fakeT3({ failIssue: true }).path });
    const r = await api(
      `/api/threads/${th.id}/requests/${encodeURIComponent(made.question)}/answer`,
      {
        method: "POST",
        body: { answers: { "Which windows?": "All" } },
      },
    );
    expect(r.status).toBe(502);
    expect(r.body.error.message).toMatch(/t3 auth session issue exited with 1: no server running/);
    expect(mcp.seen).toEqual([]);
  });

  it("validates: unknown question key, empty answers, a request no longer pending, a non-T3 thread", async () => {
    const { question, approval, th, t3 } = await setup();
    const url = (id: string, thread = th.id) =>
      `/api/threads/${thread}/requests/${encodeURIComponent(id)}/answer`;
    const post = (id: string, body: unknown, thread = th.id) =>
      api(url(id, thread), { method: "POST", body });
    expect((await post(question, { answers: { nope: "x" } })).status).toBe(400);
    expect((await post(question, { answers: {} })).status).toBe(400);
    expect((await post(question, { answers: { "Which windows?": 5 } })).status).toBe(400);
    expect((await post(question, { text: "x" })).status).toBe(400);
    // an approval is not a question
    expect((await post(approval, { answers: { x: "y" } })).status).toBe(409);
    t3.resolve(question);
    expect((await post(question, { answers: { "Which windows?": "All" } })).status).toBe(409);
    const cc = thread("claude-code", "sess", "other");
    expect((await post("1", { answers: { a: "b" } }, cc.id)).status).toBe(400);
    expect((mcp as FakeMcp).seen).toEqual([]);
  });
});

describe("approvals API (Claude Code)", () => {
  const deadPid = 2 ** 22 + 12345; // beyond pid_max on Linux defaults: no such process

  function approval(threadId: number, pid: number | undefined = process.pid) {
    return cli.requestApproval(threadId, {
      toolName: "Bash",
      inputSummary: "$ npm test",
      hookPid: pid,
    });
  }

  it("lists pending approvals for a thread, as requests too", async () => {
    const th = thread("claude-code", "sess-1");
    const a = approval(th.id);
    await start();
    const r = await api(`/api/threads/${th.id}/approvals`);
    expect(r.status).toBe(200);
    expect(r.body.approvals).toHaveLength(1);
    expect(r.body.approvals[0]).toMatchObject({
      id: a.id,
      toolName: "Bash",
      inputSummary: "$ npm test",
      decision: null,
    });
    const q = await api(`/api/threads/${th.id}/requests`);
    expect(q.body.requests).toEqual([
      expect.objectContaining({
        id: String(a.id),
        provider: "claude-code",
        kind: "approval",
        tool: "Bash",
        summary: "$ npm test",
        decidable: true,
      }),
    ]);
  });

  it("allow: records an authorization entry and the decision the hook polls for", async () => {
    const th = thread("claude-code", "sess-1");
    const a = approval(th.id);
    await start();
    const r = await api(`/api/approvals/${a.id}`, { method: "POST", body: { decision: "allow" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: a.id, decision: "allow" });
    expect(cli.getApproval(a.id).decision).toBe("allow");
    const auth = cli.listEntries("demo").find((e) => e.kind === "authorization");
    expect(auth).toMatchObject({
      author: "owner",
      data: { scope: "Bash: $ npm test", standing: false },
    });
    expect((await api(`/api/threads/${th.id}/approvals`)).body.approvals).toEqual([]);
    // deciding twice is a conflict
    expect(
      (await api(`/api/approvals/${a.id}`, { method: "POST", body: { decision: "deny" } })).status,
    ).toBe(409);
  });

  it("deny: records an owner input entry with the reason", async () => {
    const th = thread("claude-code", "sess-1");
    const a = approval(th.id);
    await start();
    const r = await api(`/api/approvals/${a.id}`, {
      method: "POST",
      body: { decision: "deny", message: "run the linter first" },
    });
    expect(r.status).toBe(200);
    expect(cli.getApproval(a.id)).toMatchObject({
      decision: "deny",
      message: "run the linter first",
    });
    const entry = cli
      .listEntries("demo")
      .filter((e) => e.kind === "owner input")
      .at(-1);
    expect(entry?.body).toBe("Denied Bash: $ npm test: run the linter first");
  });

  it("offers Claude Code's 'don't ask again' choices, and an allow can send one", async () => {
    const th = thread("claude-code", "sess-1");
    const rule = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      behavior: "allow",
      destination: "localSettings",
    };
    const edits = { type: "setMode", mode: "acceptEdits", destination: "session" };
    const a = cli.requestApproval(th.id, {
      toolName: "Bash",
      inputSummary: "$ npm test",
      hookPid: process.pid,
      suggestions: [rule, edits],
    });
    await start();
    const q = await api(`/api/threads/${th.id}/requests`);
    expect(q.body.requests[0].choices).toEqual([
      { index: 0, label: "Always allow Bash(npm test:*) in this project" },
      { index: 1, label: "Accept all edits for this session" },
    ]);
    const post = (body: unknown) => api(`/api/approvals/${a.id}`, { method: "POST", body });
    expect((await post({ decision: "allow", suggestion: 2 })).status).toBe(400);
    expect((await post({ decision: "deny", suggestion: 0 })).status).toBe(400);
    expect((await post({ decision: "allow", suggestion: -1 })).status).toBe(400);
    const r = await post({ decision: "allow", suggestion: 0 });
    expect(r.status).toBe(200);
    expect(cli.getApproval(a.id).applied).toEqual([{ ...rule, destination: "session" }, rule]);
    const auth = cli.listEntries("demo").find((e) => e.kind === "authorization");
    expect(auth).toMatchObject({
      body: "Allowed Bash: $ npm test, and: Always allow Bash(npm test:*) in this project",
      data: { scope: "Always allow Bash(npm test:*) in this project", standing: true },
    });
  });

  it("a plain allow sends no rule", async () => {
    const th = thread("claude-code", "sess-1");
    const a = cli.requestApproval(th.id, {
      toolName: "Edit",
      inputSummary: "Editing a.ts",
      hookPid: process.pid,
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    await start();
    await api(`/api/approvals/${a.id}`, { method: "POST", body: { decision: "allow" } });
    expect(cli.getApproval(a.id)).toMatchObject({ decision: "allow", applied: null });
  });

  it("validates the body, the id and the approval", async () => {
    const th = thread("claude-code", "sess-1");
    const a = approval(th.id);
    await start();
    const post = (id: string | number, body: unknown) =>
      api(`/api/approvals/${id}`, { method: "POST", body });
    expect((await post(a.id, { decision: "maybe" })).status).toBe(400);
    expect((await post(a.id, {})).status).toBe(400);
    expect((await post(a.id, { decision: "allow", extra: 1 })).status).toBe(400);
    expect((await post("x", { decision: "allow" })).status).toBe(400);
    expect((await post(999, { decision: "allow" })).status).toBe(404);
    expect(cli.getApproval(a.id).decision).toBeNull();
  });

  it("an approval whose hook is gone expires instead of being decided", async () => {
    const th = thread("claude-code", "sess-1");
    const a = approval(th.id, deadPid);
    await start();
    const r = await api(`/api/approvals/${a.id}`, { method: "POST", body: { decision: "allow" } });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/no longer waiting/);
    expect(cli.getApproval(a.id).decision).toBe("expired");
    expect(cli.listEntries("demo").filter((e) => e.kind === "authorization")).toEqual([]);
    // and it vanishes from the lists
    const b = approval(th.id, deadPid);
    expect((await api(`/api/threads/${th.id}/approvals`)).body.approvals).toEqual([]);
    expect(cli.getApproval(b.id).decision).toBe("expired");
  });
});

describe("/api/desk pendingRequests", () => {
  it("counts waiting T3 requests and pending Claude Code approvals per thread", async () => {
    const { t3 } = t3WithRequests();
    const t3th = thread("t3", "th-1");
    const cc = thread("claude-code", "sess-1");
    const idle = thread("claude-code", "sess-2");
    cli.requestApproval(cc.id, { toolName: "Bash", inputSummary: "$ ls", hookPid: process.pid });
    cli.requestApproval(cc.id, { toolName: "Write", inputSummary: "Editing a.ts" });
    const dead = cli.requestApproval(idle.id, {
      toolName: "Bash",
      inputSummary: "$ x",
      hookPid: 2 ** 22 + 99,
    });
    await start({ t3Dir: t3.dir });
    const desk = (await api("/api/desk")).body;
    const byId = new Map<number, Any>(desk.topics[0].threads.map((x: Any) => [x.id, x]));
    expect(byId.get(t3th.id).pendingRequests).toBe(2);
    expect(byId.get(cc.id).pendingRequests).toBe(2);
    expect(byId.get(idle.id).pendingRequests).toBe(0);
    expect(cli.getApproval(dead.id).decision).toBe("expired");
  });
});
