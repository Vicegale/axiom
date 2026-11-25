import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const API = "http://127.0.0.1:4477";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // No changeOrigin: the server rejects any Host that is not loopback.
    proxy: { "/api": { target: API } },
  },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
