/**
 * `axiom agents allow` / `axiom agents disallow`: let agents run the `axiom` CLI without asking.
 *
 * - Claude Code: `Bash(axiom *)` in `permissions.allow` of ~/.claude/settings.json.
 * - Codex: its `workspace-write` sandbox only writes inside the project, and the database lives in
 *   the data folder, so that folder goes into `[sandbox_workspace_write] writable_roots` of
 *   ~/.codex/config.toml. Nothing is needed when Codex runs with full access.
 *
 * The TOML is edited as text (no parser dependency) and only in the shapes below; anything else
 * is reported back with the line to add by hand.
 */

type Json = Record<string, unknown>;

export const CLAUDE_ALLOW_RULE = "Bash(axiom *)";

function allowList(settings: Json): unknown[] {
  const p = settings.permissions;
  const allow = p && typeof p === "object" ? (p as Json).allow : undefined;
  return Array.isArray(allow) ? allow : [];
}

export function claudeAllows(settings: Json): boolean {
  return allowList(settings).includes(CLAUDE_ALLOW_RULE);
}

export function allowCliIn(settings: Json): Json {
  if (claudeAllows(settings)) return settings;
  const out: Json = structuredClone(settings);
  const permissions = (
    out.permissions && typeof out.permissions === "object" ? out.permissions : {}
  ) as Json;
  permissions.allow = [...allowList(out), CLAUDE_ALLOW_RULE];
  out.permissions = permissions;
  return out;
}

export function disallowCliFrom(settings: Json): Json {
  if (!claudeAllows(settings)) return settings;
  const out: Json = structuredClone(settings);
  const permissions = out.permissions as Json;
  permissions.allow = allowList(out).filter((r) => r !== CLAUDE_ALLOW_RULE);
  return out;
}

export interface CodexEdit {
  /** The new file text (unchanged when nothing was done). */
  text: string;
  changed: boolean;
  /** What happened, in one line. */
  note: string;
}

const TABLE = "[sandbox_workspace_write]";
const quote = (s: string) => JSON.stringify(s); // a TOML basic string for ordinary paths

/** Top-level `sandbox_mode` (before the first table), or undefined. */
export function codexSandboxMode(toml: string): string | undefined {
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*sandbox_mode\s*=\s*"([^"]*)"/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** The [sandbox_workspace_write] table's line range: [header, end) */
function tableRange(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === TABLE);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] as string)) end++;
  return [start, end];
}

export function codexAllowRoot(toml: string, dir: string): CodexEdit {
  const keep = (note: string): CodexEdit => ({ text: toml, changed: false, note });
  const lines = toml.split("\n");
  const range = tableRange(lines);
  const entry = quote(dir);
  if (!range) {
    const sep = toml === "" || toml.endsWith("\n\n") ? "" : toml.endsWith("\n") ? "\n" : "\n\n";
    return {
      text: `${toml}${sep}${TABLE}\nwritable_roots = [${entry}]\n`,
      changed: true,
      note: `added ${dir} to writable_roots`,
    };
  }
  const [start, end] = range;
  const at = lines.slice(start + 1, end).findIndex((l) => /^\s*writable_roots\s*=/.test(l));
  if (at < 0) {
    lines.splice(start + 1, 0, `writable_roots = [${entry}]`);
    return { text: lines.join("\n"), changed: true, note: `added ${dir} to writable_roots` };
  }
  const i = start + 1 + at;
  const line = lines[i] as string;
  if (line.includes(entry)) return keep(`${dir} is already in writable_roots`);
  const m = /^(\s*writable_roots\s*=\s*\[)(.*)\](\s*(#.*)?)$/.exec(line);
  if (!m) {
    return keep(
      `writable_roots spans several lines; add ${entry} to it by hand in the ${TABLE} table`,
    );
  }
  const items = (m[2] as string).trim().replace(/,\s*$/, "");
  lines[i] = `${m[1]}${items ? `${items}, ` : ""}${entry}]${m[3] ?? ""}`;
  return { text: lines.join("\n"), changed: true, note: `added ${dir} to writable_roots` };
}

export function codexDisallowRoot(toml: string, dir: string): CodexEdit {
  const entry = quote(dir);
  const lines = toml.split("\n");
  const range = tableRange(lines);
  if (!range) return { text: toml, changed: false, note: "nothing to remove" };
  const [start, end] = range;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i] as string;
    const m = /^(\s*writable_roots\s*=\s*\[)(.*)\](.*)$/.exec(line);
    if (!m || !line.includes(entry)) continue;
    const rest = (m[2] as string)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "" && s !== entry);
    if (rest.length === 0) lines.splice(i, 1);
    else lines[i] = `${m[1]}${rest.join(", ")}]${m[3]}`;
    return { text: lines.join("\n"), changed: true, note: `removed ${dir} from writable_roots` };
  }
  return { text: toml, changed: false, note: "nothing to remove" };
}
