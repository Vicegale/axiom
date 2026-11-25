/**
 * The short human line for "what the agent is doing now" (the Desk card's activity line). Shared
 * by the Claude Code `PreToolUse` hook and the T3 reader, so both providers word a step the same.
 */

/** Folds whitespace into single spaces, trims, and caps the length with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const LINE_MAX = 200;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * One line for a tool call: Bash `$ <first line>`, Read `Reading <file>`, Edit/Write/MultiEdit
 * `Editing <file>`, Grep/Glob `Searching <pattern>`, WebFetch `Fetching <host>`, WebSearch
 * `Searching the web`, Task/Agent `Subagent: <description>`, `mcp__server__tool` `server: tool`,
 * anything else the tool's name. Never throws; `input` may be anything.
 */
export function describeToolUse(toolName: string, input: unknown): string {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const name = toolName.trim();
  let line: string;
  switch (name) {
    case "Bash": {
      const first = str(i.command)
        .split("\n")
        .find((l) => l.trim() !== "");
      line = first ? `$ ${first}` : "Bash";
      break;
    }
    case "Read":
      line = str(i.file_path) ? `Reading ${baseName(str(i.file_path))}` : "Read";
      break;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const path = str(i.file_path) || str(i.notebook_path);
      line = path ? `Editing ${baseName(path)}` : name;
      break;
    }
    case "Grep":
    case "Glob":
      line = str(i.pattern) ? `Searching ${str(i.pattern)}` : name;
      break;
    case "WebFetch":
      line = str(i.url) ? `Fetching ${host(str(i.url))}` : "Fetching a page";
      break;
    case "WebSearch":
      line = "Searching the web";
      break;
    case "Task":
    case "Agent": {
      const d = str(i.description) || str(i.subagent_type);
      line = d ? `Subagent: ${d}` : "Subagent";
      break;
    }
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      line = m ? `${m[1]}: ${m[2]}` : name;
    }
  }
  return oneLine(line, LINE_MAX);
}
