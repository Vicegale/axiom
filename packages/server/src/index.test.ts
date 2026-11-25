import { expect, it } from "vitest";
import { createServer } from "./index.js";

it("imports and exposes createServer", () => {
  expect(typeof createServer).toBe("function");
});
