import { buildApp, resolveDefaultDbPath, resolveDefaultEventLogPath } from "./app.js";

const app = buildApp({
  dbPath: resolveDefaultDbPath(import.meta.url),
  eventLogPath: resolveDefaultEventLogPath(import.meta.url)
});

app.listen({ host: "127.0.0.1", port: 4318 }).catch((error: unknown) => {
  app.log.error(error as Error);
  process.exit(1);
});
