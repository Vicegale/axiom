import { defineConfig } from "vitest/config";

// These tests start the CLI as a child process several times each; the first start is cold. Under
// load (other test files running at once, or a busy machine) that can pass the 5 s default,
// which was the one unexplained failure seen after ST2.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
