import { fileURLToPath } from "node:url";
import { buildApp, resolveDefaultDbPath, resolveDefaultEventLogPath } from "./app.js";

const app = buildApp({
  dbPath: resolveDefaultDbPath(import.meta.url),
  eventLogPath: resolveDefaultEventLogPath(import.meta.url),
  repoRoot: fileURLToPath(new URL("../../..", import.meta.url))
});

const port = Number(process.env.AGENT_METRICS_CORE_PORT ?? "45183");

app.listen({ host: "127.0.0.1", port }).catch((error: unknown) => {
  app.log.error(error as Error);
  process.exit(1);
});
