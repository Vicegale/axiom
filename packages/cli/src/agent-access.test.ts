import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  allowCliIn,
  claudeAllows,
  codexAllowRoot,
  codexDisallowRoot,
  codexSandboxMode,
  disallowCliFrom,
} from "./agent-access.js";

const DIR = "/home/me/.local/share/axiom";

describe("Claude Code allow rule", () => {
  it("adds Bash(axiom *) once, keeping other rules and settings", () => {
    const s = { model: "opus", permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm *)"] } };
    const next = allowCliIn(s);
    expect(next).toEqual({
      model: "opus",
      permissions: { allow: ["Bash(ls)", "Bash(axiom *)"], deny: ["Bash(rm *)"] },
    });
    expect(s.permissions.allow).toEqual(["Bash(ls)"]); // not mutated
    expect(allowCliIn(next)).toBe(next);
    expect(allowCliIn({})).toEqual({ permissions: { allow: ["Bash(axiom *)"] } });
  });

  it("removes only its own rule", () => {
    const s = { permissions: { allow: ["Bash(ls)", "Bash(axiom *)"] } };
    expect(claudeAllows(s)).toBe(true);
    expect(disallowCliFrom(s)).toEqual({ permissions: { allow: ["Bash(ls)"] } });
    expect(disallowCliFrom({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("Codex writable_roots", () => {
  it("reads the top-level sandbox mode only", () => {
    expect(codexSandboxMode('model = "x"\nsandbox_mode = "workspace-write"\n')).toBe(
      "workspace-write",
    );
    expect(codexSandboxMode('[profiles.a]\nsandbox_mode = "danger-full-access"\n')).toBeUndefined();
  });

  it("appends the table to a file without one", () => {
    expect(codexAllowRoot("", DIR).text).toBe(
      `[sandbox_workspace_write]\nwritable_roots = ["${DIR}"]\n`,
    );
    const r = codexAllowRoot('model = "gpt"\n', DIR);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(
      `model = "gpt"\n\n[sandbox_workspace_write]\nwritable_roots = ["${DIR}"]\n`,
    );
  });

  it("adds the key to an existing table, before the next table", () => {
    const toml =
      '[sandbox_workspace_write]\nnetwork_access = false\n\n[mcp_servers.x]\ncommand = "y"\n';
    expect(codexAllowRoot(toml, DIR).text).toBe(
      `[sandbox_workspace_write]\nwritable_roots = ["${DIR}"]\nnetwork_access = false\n\n[mcp_servers.x]\ncommand = "y"\n`,
    );
  });

  it("extends a one-line array, and is idempotent", () => {
    const toml = '[sandbox_workspace_write]\nwritable_roots = ["/opt/a"] # mine\n';
    const once = codexAllowRoot(toml, DIR);
    expect(once.text).toBe(
      `[sandbox_workspace_write]\nwritable_roots = ["/opt/a", "${DIR}"] # mine\n`,
    );
    const twice = codexAllowRoot(once.text, DIR);
    expect(twice.changed).toBe(false);
    expect(codexAllowRoot("[sandbox_workspace_write]\nwritable_roots = []\n", DIR).text).toBe(
      `[sandbox_workspace_write]\nwritable_roots = ["${DIR}"]\n`,
    );
  });

  it("leaves a multi-line array alone and says what to add", () => {
    const toml = '[sandbox_workspace_write]\nwritable_roots = [\n  "/opt/a",\n]\n';
    const r = codexAllowRoot(toml, DIR);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(toml);
    expect(r.note).toContain("by hand");
  });

  it("removes only its own root, and the key when it was the only one", () => {
    const both = `[sandbox_workspace_write]\nwritable_roots = ["/opt/a", "${DIR}"]\n`;
    expect(codexDisallowRoot(both, DIR).text).toBe(
      '[sandbox_workspace_write]\nwritable_roots = ["/opt/a"]\n',
    );
    const only = `x = 1\n\n[sandbox_workspace_write]\nwritable_roots = ["${DIR}"]\n`;
    expect(codexDisallowRoot(only, DIR).text).toBe("x = 1\n\n[sandbox_workspace_write]\n");
    expect(codexDisallowRoot("x = 1\n", DIR).changed).toBe(false);
  });
});

describe("axiom agents allow / disallow", () => {
  const root = mkdtempSync(join(tmpdir(), "axiom-agents-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  let n = 0;

  function setup(withCodex: boolean) {
    const home = join(root, `h-${n++}`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    if (withCodex) mkdirSync(join(home, ".codex"));
    const db = join(home, "data", "axiom", "axiom.db");
    const exec = (args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env.AXIOM_DB;
      const r = spawnSync(
        process.execPath,
        ["--conditions=source", "--import", "tsx", entry, "--db", db, "agents", ...args],
        { encoding: "utf8", env },
      );
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    return { home, exec, dataDir: join(home, "data", "axiom") };
  }

  it("allows the CLI in Claude Code and Codex, with backups, and undoes it", () => {
    const s = setup(true);
    const settings = join(s.home, ".claude", "settings.json");
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const config = join(s.home, ".codex", "config.toml");
    writeFileSync(config, 'sandbox_mode = "workspace-write"\n');

    const r = s.exec(["allow"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.allow).toEqual([
      "Bash(ls)",
      "Bash(axiom *)",
    ]);
    expect(readFileSync(config, "utf8")).toContain(`writable_roots = ["${s.dataDir}"]`);
    expect(readdirSync(join(s.home, ".claude")).some((f) => f.includes(".axiom-backup-"))).toBe(
      true,
    );
    expect(readdirSync(join(s.home, ".codex")).some((f) => f.includes(".axiom-backup-"))).toBe(
      true,
    );
    expect(s.exec(["allow"]).out).toContain("already");
    expect(r.out).toContain("added Bash(axiom *)");

    expect(s.exec(["disallow"]).code).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.allow).toEqual(["Bash(ls)"]);
    expect(readFileSync(config, "utf8")).not.toContain(s.dataDir);
  });

  it("skips Codex when it isn't installed, and --dry-run writes nothing", () => {
    const s = setup(false);
    const r = s.exec(["allow", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("would add Bash(axiom *)");
    expect(r.out).toContain("Codex: not installed");
    expect(existsSync(join(s.home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(s.home, ".codex"))).toBe(false);
  });
});
