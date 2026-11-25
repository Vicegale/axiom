import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverArgs } from "./server-command.js";

describe("serverArgs", () => {
  it("is null for other commands", () => {
    expect(serverArgs(["topic", "list"])).toBeNull();
    expect(serverArgs(["--db", "x.db", "hook", "stop"])).toBeNull();
  });
  it("drops `start`, keeps flags, and forwards the global --db", () => {
    expect(serverArgs(["server"])).toEqual([]);
    expect(serverArgs(["server", "start", "--port", "5000"])).toEqual(["--port", "5000"]);
    expect(serverArgs(["--db", "a.db", "server", "install", "--dry-run"])).toEqual([
      "install",
      "--dry-run",
      "--db",
      "a.db",
    ]);
  });
});

describe("axiom server install --dry-run", () => {
  it("prints the unit and writes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "axiom-srv-"));
    const out = execFileSync(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "src/index.ts", "server", "install", "--dry-run"],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    );
    expect(out).toContain("ExecStart=");
    expect(out).toContain("dry run");
  });
});
