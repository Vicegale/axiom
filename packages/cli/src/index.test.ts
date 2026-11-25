import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AXIOM_VERSION } from "@axiom/core";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const run = (...args: string[]) =>
  execFileSync(process.execPath, ["--conditions=source", "--import", "tsx", entry, ...args], {
    encoding: "utf8",
  }).trim();

it("prints the core version with --version", () => {
  expect(run("--version")).toBe(AXIOM_VERSION);
});

it("prints a usage line with no args", () => {
  expect(run()).toMatch(/^Usage: axiom/);
});
