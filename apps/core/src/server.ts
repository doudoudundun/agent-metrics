import { randomBytes } from "node:crypto";
import { buildApp } from "./app.js";
import { repairBrokenIngestionCursor } from "./event-log-projector.js";
import { resolveCoreRuntimeConfig } from "./server-runtime.js";

function resolveLocalAccessToken(env: NodeJS.ProcessEnv): string {
  const existing = env.AGENT_METRICS_LOCAL_TOKEN?.trim();
  if (existing) {
    return existing;
  }
  const generated = randomBytes(24).toString("hex");
  env.AGENT_METRICS_LOCAL_TOKEN = generated;
  return generated;
}

const runtimeConfig = resolveCoreRuntimeConfig({
  moduleUrl: import.meta.url,
  env: process.env
});
const localAccessToken = resolveLocalAccessToken(process.env);
const app = buildApp({
  dbPath: runtimeConfig.dbPath,
  eventLogPath: runtimeConfig.eventLogPath,
  repoRoot: runtimeConfig.repoRoot,
  localAccessToken
});

const port = Number(process.env.AGENT_METRICS_CORE_PORT ?? "45183");

async function main(): Promise<void> {
  // Repair cursors before listen, but do NOT run catch-up ingest here.
  // projectEventLog uses better-sqlite3 synchronously; a large backlog wedges the
  // Node event loop so /api/health accepts TCP but never responds, and the
  // desktop supervisor's readiness poll then kills Core in a restart loop.
  // Catch-up is covered by SyncCoordinator periodic sync + manual Sync (see
  // app.ts onReady).
  if (runtimeConfig.eventLogPath) {
    try {
      const repaired = await repairBrokenIngestionCursor({
        db: app.db as never,
        eventLogPath: runtimeConfig.eventLogPath
      });
      if (repaired.repaired) {
        app.log.info(
          { committedOffset: repaired.committedOffset },
          "repaired broken events.jsonl ingestion cursor"
        );
      }
    } catch (error) {
      app.log.error(error as Error);
    }
  }

  await app.listen({ host: "127.0.0.1", port });
}

main().catch((error: unknown) => {
  app.log.error(error as Error);
  process.exit(1);
});
