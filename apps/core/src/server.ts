import { buildApp } from "./app.js";
import { resolveCoreRuntimeConfig } from "./server-runtime.js";

const runtimeConfig = resolveCoreRuntimeConfig({
  moduleUrl: import.meta.url,
  env: process.env
});
const app = buildApp({
  dbPath: runtimeConfig.dbPath,
  eventLogPath: runtimeConfig.eventLogPath,
  repoRoot: runtimeConfig.repoRoot
});

const port = Number(process.env.AGENT_METRICS_CORE_PORT ?? "45183");

app.listen({ host: "127.0.0.1", port }).catch((error: unknown) => {
  app.log.error(error as Error);
  process.exit(1);
});
