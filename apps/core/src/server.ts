import { randomBytes } from "node:crypto";
import { buildApp } from "./app.js";
import { repairBrokenIngestionCursor } from "./event-log-projector.js";
import { resolveDetailRetentionConfig, runDetailRetentionIfNeeded } from "./detail-retention.js";
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

  // 明细裁剪放在 listen 之后：它是维护工作，不该拖慢就绪探测，也不该在
  // /api/health 还没答上来时先跑一个长事务。首次启动跑一次，之后按配置的
  // 间隔复查（默认 24 小时，检查频率最多 6 小时一次）。真正的时间节流靠
  // 状态文件里的 lastRunAt，所以重启不会导致重复裁剪。
  if (runtimeConfig.dbPath) {
    const retentionConfig = resolveDetailRetentionConfig({
      env: process.env,
      eventLogPath: runtimeConfig.eventLogPath,
      dbPath: runtimeConfig.dbPath
    });
    if (retentionConfig.enabled) {
      const trimOnce = () => {
        void runDetailRetentionIfNeeded({
          db: app.db as never,
          config: retentionConfig,
          logger: app.log
        }).catch((error: unknown) => {
          app.log.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "detail retention failed"
          );
        });
      };
      trimOnce();
      const checkIntervalMs =
        Math.min(retentionConfig.intervalHours, 6) * 60 * 60 * 1000;
      const timer = setInterval(trimOnce, checkIntervalMs);
      // 不阻止进程退出：定时器只是维护，不该让 Ctrl+C 卡住。
      timer.unref();
    }
  }

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
