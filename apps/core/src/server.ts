import { fileURLToPath } from "node:url";
import { buildApp, resolveDefaultDbPath, resolveDefaultEventLogPath } from "./app.js";

const repoRoot = process.env.AGENT_METRICS_REPO_ROOT ?? fileURLToPath(new URL("../../..", import.meta.url));
const app = buildApp({
  dbPath: process.env.AGENT_METRICS_DB_PATH ?? resolveDefaultDbPath(import.meta.url),
  eventLogPath: process.env.AGENT_METRICS_EVENT_LOG_PATH ?? resolveDefaultEventLogPath(import.meta.url),
  repoRoot
});

const port = Number(process.env.AGENT_METRICS_CORE_PORT ?? "45183");

app.listen({ host: "127.0.0.1", port }).catch((error: unknown) => {
  app.log.error(error as Error);
  process.exit(1);
});
