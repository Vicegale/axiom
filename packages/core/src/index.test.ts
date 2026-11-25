import { expect, it } from "vitest";
import { AXIOM_VERSION } from "./index.js";

it("exports a semver version string", () => {
  expect(AXIOM_VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
