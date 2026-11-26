import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryEnv } from "../claude.js";

/**
 * Which connectors (MCP servers) a headless `claude` has. The `system`/`init` event of
 * `--output-format stream-json` lists them with a status and lists the tools, and Claude Code
 * emits it at startup, before the first model call. The probe starts the same kind of call as
 * gather, reads that one line and kills the process, so it spends (almost) no tokens.
 */

export interface McpServerInfo {
  /** The name as Claude Code shows it, for example `claude.ai Google Drive`. */
  name: string;
  /** `connected`, `needs-auth`, `failed`, `pending`, ... */
  status: string;
  /** The server's tools in the init event, by full name (`mcp__<server>__<tool>`). */
  tools: string[];
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
  servers: McpServerInfo[];
  at: number;
}

/** The server name as it appears in tool names: anything but letters, digits, `_` and `-` becomes `_`. */
export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Reads the init event's `mcp_servers` and `tools`. */
export function parseInitEvent(ev: unknown, at: number): ProbeResult | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: string; subtype?: string; mcp_servers?: unknown; tools?: unknown };
  if (e.type !== "system" || e.subtype !== "init") return null;
  const tools = Array.isArray(e.tools)
    ? e.tools.filter((t): t is string => typeof t === "string")
    : [];
  const servers = (Array.isArray(e.mcp_servers) ? e.mcp_servers : [])
    .filter((s): s is { name: string; status?: string } => typeof s?.name === "string")
    .map((s) => ({
      name: s.name,
      status: typeof s.status === "string" ? s.status : "unknown",
      tools: tools.filter((t) => t.startsWith(`mcp__${normalizeServerName(s.name)}__`)),
    }));
  return { ok: true, servers, at };
}

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => number;
}

/** Starts a trimmed headless call just far enough to read its init event, then kills it. */
export function probeClaudeMcp(cli: string, o: ProbeOptions = {}): Promise<ProbeResult> {
  const now = o.now ?? Date.now;
  return new Promise((resolve) => {
    const cwd = mkdtempSync(join(tmpdir(), "axiom-probe-"));
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rmSync(cwd, { recursive: true, force: true });
      resolve(r);
    };
    let settled = false;
    let buf = "";
    const child = spawn(
      cli,
      [
        "-p",
        "--model",
        "haiku",
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
        // The user's settings: claude.ai connectors only load with them (see CONNECTOR_FLAGS).
        "--setting-sources",
        "user",
        "--disable-slash-commands",
        "--tools",
        "Read",
        "--system-prompt",
        "Reply ok.",
      ],
      { cwd, env: summaryEnv(o.env ?? process.env), stdio: ["pipe", "pipe", "ignore"] },
    );
    const timer = setTimeout(
      () =>
        done({ ok: false, error: "timed out waiting for claude to start", servers: [], at: now() }),
      o.timeoutMs ?? 30_000,
    );
    child.on("error", (e) =>
      done({ ok: false, error: `cannot run ${cli}: ${e.message}`, servers: [], at: now() }),
    );
    child.on("close", (code) =>
      done({
        ok: false,
        error: `claude exited (${code}) before it started`,
        servers: [],
        at: now(),
      }),
    );
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line) continue;
        try {
          const r = parseInitEvent(JSON.parse(line), now());
          if (r) return done(r);
        } catch {}
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end("ok");
  });
}

export type ConnectorSource = "slack" | "googleDrive";

export interface SourceAvailability {
  available: boolean;
  /** Why not, in a sentence. */
  reason?: string;
  /** The read-only tools gather may call (full names). */
  tools: string[];
  servers: string[];
}

const SOURCE_PATTERN: Record<ConnectorSource, RegExp> = {
  slack: /slack/i,
  googleDrive: /google[\s_-]*drive|gdrive/i,
};
const SOURCE_LABEL: Record<ConnectorSource, string> = {
  slack: "Slack",
  googleDrive: "Google Drive",
};

const READ_WORDS = /(search|read|get|list|fetch|find|view|query|history|download|info|summar)/i;
const WRITE_WORDS =
  /(send|post|create|update|delete|write|edit|draft|schedule|react|upload|invite|archive|remove|set[_-]|add[_-]|reply|share|move|rename|copy|mark|join|leave|trash|publish)/i;

/** Whether a connector tool only reads (by its name: the only thing the init event gives). */
export function isReadTool(fullName: string): boolean {
  const tool = fullName.split("__").slice(2).join("__");
  return READ_WORDS.test(tool) && !WRITE_WORDS.test(tool);
}

/** Which of Slack and Google Drive are usable in the probe result, and through which read tools. */
export function classifyConnectors(
  probe: ProbeResult,
): Record<ConnectorSource, SourceAvailability> {
  const out = {} as Record<ConnectorSource, SourceAvailability>;
  for (const source of Object.keys(SOURCE_PATTERN) as ConnectorSource[]) {
    const label = SOURCE_LABEL[source];
    if (!probe.ok) {
      out[source] = {
        available: false,
        reason: `${label}: ${probe.error ?? "claude could not be probed"}`,
        tools: [],
        servers: [],
      };
      continue;
    }
    const matching = probe.servers.filter((s) => SOURCE_PATTERN[source].test(s.name));
    if (matching.length === 0) {
      out[source] = {
        available: false,
        reason: `${label}: no connector in Claude Code on this machine`,
        tools: [],
        servers: [],
      };
      continue;
    }
    const connected = matching.filter((s) => s.status === "connected");
    if (connected.length === 0) {
      const st = matching.map((s) => `${s.name} is ${s.status}`).join(", ");
      out[source] = { available: false, reason: `${label}: ${st}`, tools: [], servers: [] };
      continue;
    }
    const tools = connected.flatMap((s) => s.tools).filter(isReadTool);
    out[source] =
      tools.length > 0
        ? { available: true, tools, servers: connected.map((s) => s.name) }
        : {
            available: false,
            reason: `${label}: connected, but no read-only tool was listed`,
            tools: [],
            servers: [],
          };
  }
  return out;
}

export interface ConnectorProbeOptions {
  cli: () => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long a good result is kept (default 3 hours) and a failed one (default 10 minutes). */
  ttlMs?: number;
  failTtlMs?: number;
  /** Replaces the real probe (tests). */
  probe?: (cli: string) => Promise<ProbeResult>;
}

/** The probe with a cache: one `claude` start every few hours, not one per wake. */
export class ConnectorProbe {
  private cached: ProbeResult | null = null;
  private inflight: Promise<ProbeResult> | null = null;

  constructor(private readonly o: ConnectorProbeOptions) {}

  async get(): Promise<ProbeResult> {
    const now = (this.o.now ?? Date.now)();
    const c = this.cached;
    if (c) {
      const pending = c.servers.some((s) => s.status === "pending");
      const ttl =
        c.ok && !pending ? (this.o.ttlMs ?? 3 * 3_600_000) : (this.o.failTtlMs ?? 600_000);
      if (now - c.at < ttl) return c;
    }
    this.inflight ??= (
      this.o.probe
        ? this.o.probe(this.o.cli())
        : probeClaudeMcp(this.o.cli(), { env: this.o.env, now: this.o.now })
    )
      .then((r) => {
        this.cached = r;
        return r;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
