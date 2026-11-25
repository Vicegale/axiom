import { writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";

/** One id per build: baked into the page, and written next to it for the server to read at start. */
const BUILD_ID = Date.now().toString(36);
const buildIdFile = (): Plugin => ({
  name: "axiom-build-id",
  apply: "build",
  writeBundle(options) {
    writeFileSync(join(options.dir ?? "dist", "build-id.txt"), BUILD_ID);
  },
});

const API = "http://127.0.0.1:4477";

export default defineConfig({
  plugins: [react(), tailwindcss(), buildIdFile()],
  define: { __AXIOM_BUILD__: JSON.stringify(BUILD_ID) },
  server: {
    // No changeOrigin: the server rejects any Host that is not loopback.
    proxy: { "/api": { target: API } },
  },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
