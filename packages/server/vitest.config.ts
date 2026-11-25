import { defineConfig } from "vitest/config";

// Resolve @axiom/core to its TypeScript source so tests do not depend on a prior build.
export default defineConfig({
  resolve: { conditions: ["source"] },
  test: { testTimeout: 15_000 },
});
