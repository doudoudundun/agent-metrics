import { randomBytes } from "node:crypto";
import { buildApp } from "./app.js";
import { repairBrokenIngestionCursor } from "./event-log-projector.js";
import {
  compressEventLogArchive,
  resolveEventLogRotationConfig,
  rotateEventLogIfNeeded
} from "./event-log-rotation.js";
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
  // Keep events.jsonl bounded before anything reads it. A multi-gigabyte log is
  // what wedges startup: the catch-up ingest never lets the event loop answer
  // /api/health, so the desktop supervisor sees a readiness timeout. Trimming
  // here means the projector below only ever faces a bounded backlog.
  let archiveToCompress: string | null = null;
  if (runtimeConfig.eventLogPath) {
    try {
      const rotationConfig = resolveEventLogRotationConfig(process.env);
      const rotation = await rotateEventLogIfNeeded({
        eventLogPath: runtimeConfig.eventLogPath,
        maxBytes: rotationConfig.maxBytes,
        retentionDays: rotationConfig.retentionDays,
        logger: app.log
      });
      if (rotation.rotated) {
        archiveToCompress = rotation.archivePath;
      }
    } catch (error) {
      app.log.error(error as Error);
    }
  }

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

  // Compression runs off the readiness path; a failure just leaves the plain
  // archive in place, which is still a valid backup.
  if (archiveToCompress !== null) {
    const pending = archiveToCompress;
    void compressEventLogArchive(pending)
      .then((gzPath) => {
        app.log.info({ archivePath: gzPath }, "compressed rotated events.jsonl archive");
      })
      .catch((error: unknown) => {
        app.log.warn(
          { archivePath: pending, error: error instanceof Error ? error.message : String(error) },
          "failed to compress rotated events.jsonl archive"
        );
      });
  }
}

main().catch((error: unknown) => {
  app.log.error(error as Error);
  process.exit(1);
});
