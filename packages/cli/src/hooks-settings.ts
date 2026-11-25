import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HOOK_EVENTS, type HookEvent } from "./hook.js";

/** Claude Code settings hook names for each `axiom hook` event. */
export const CLAUDE_EVENT: Record<HookEvent, string> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  "pre-tool": "PreToolUse",
  notification: "Notification",
  stop: "Stop",
  "session-end": "SessionEnd",
};

type Json = Record<string, unknown>;
interface HookEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [key: string]: unknown;
}

export function hookCommand(node: string, entry: string, event: HookEvent): string {
  return `"${node}" "${entry}" hook ${event}`;
}

/**
 * Axiom's own entries are recognised by their shape: `"<node>" "<...>/cli/{dist,src}/index.{js,ts}"
 * hook <event>`, for the event the entry sits under. Anything else is left alone.
 */
function isAxiomCommand(command: unknown, event: HookEvent): boolean {
  if (typeof command !== "string") return false;
  const m = /^"[^"]+" "[^"]+[\\/]cli[\\/](?:dist|src)[\\/]index\.(?:js|ts)" hook ([a-z-]+)$/.exec(
    command,
  );
  return m !== null && m[1] === event;
}

export function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Json;
}

/** Adds Axiom's hooks, or updates their command if the install location changed. */
export function installInto(settings: Json, node: string, entry: string): Json {
  const out: Json = structuredClone(settings);
  const hooks = (out.hooks && typeof out.hooks === "object" ? out.hooks : {}) as Record<
    string,
    HookGroup[]
  >;
  for (const event of HOOK_EVENTS) {
    const name = CLAUDE_EVENT[event];
    const command = hookCommand(node, entry, event);
    const groups = Array.isArray(hooks[name]) ? hooks[name] : [];
    let found = false;
    for (const group of groups) {
      for (const h of group.hooks ?? []) {
        if (isAxiomCommand(h.command, event)) {
          found = true;
          h.command = command;
        }
      }
    }
    if (!found) groups.push({ hooks: [{ type: "command", command }] });
    hooks[name] = groups;
  }
  out.hooks = hooks;
  return out;
}

/** Removes only Axiom's entries, and the groups, arrays and objects that leaves empty. */
export function uninstallFrom(settings: Json): Json {
  const out: Json = structuredClone(settings);
  if (!out.hooks || typeof out.hooks !== "object") return out;
  const hooks = out.hooks as Record<string, HookGroup[]>;
  for (const event of HOOK_EVENTS) {
    const name = CLAUDE_EVENT[event];
    if (!Array.isArray(hooks[name])) continue;
    const kept: HookGroup[] = [];
    for (const group of hooks[name]) {
      if (!Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const rest = group.hooks.filter((h) => !isAxiomCommand(h.command, event));
      if (rest.length === group.hooks.length) kept.push(group);
      else if (rest.length > 0) kept.push({ ...group, hooks: rest });
    }
    if (kept.length > 0) hooks[name] = kept;
    else delete hooks[name];
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Writes `next` to `path`, copying the existing file to `<path>.axiom-backup-<stamp>` first. */
export function writeSettings(
  path: string,
  current: Json,
  next: Json,
): { backup?: string; changed: boolean } {
  if (JSON.stringify(current) === JSON.stringify(next)) return { changed: false };
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.axiom-backup-${stamp(new Date())}`;
    copyFileSync(path, backup);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { backup, changed: true };
}
