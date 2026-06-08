import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const corePort = process.env.AGENT_METRICS_CORE_PORT ?? "45183";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": `http://127.0.0.1:${corePort}`
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  },
  test: {
    environment: "jsdom"
  }
});
