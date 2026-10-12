import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { syncKnownClaudeTranscripts } from "@agent-metrics/adapters-claude";
import { syncCodexRollouts } from "@agent-metrics/adapters-codex";
import { syncCursorArtifacts, syncCursorOfficialUsage } from "@agent-metrics/adapters-cursor";
import { syncOpenCodeDatabase, syncZCodeDatabase } from "@agent-metrics/adapters-opencode";
import { syncKimicodeSessions } from "@agent-metrics/adapters-kimicode";
import { syncMiMoDatabase } from "@agent-metrics/adapters-mimo";
import { syncDshSessions } from "@agent-metrics/adapters-dsh";
import { getAgentMetricsPaths } from "@agent-metrics/shared-utils";
import { runDomainMigrations, type SqliteDatabaseLike } from "./domain-migrations.js";
import {
  SyncCoordinator,
  type SyncAdapter,
  type SyncResult
} from "./sync-coordinator.js";
import { initializeLegacySchema } from "./legacy-schema.js";
import {
  createEventLogSynchronizer as createIncrementalEventLogSynchronizer,
  ingestEventLog as projectEventLog,
  persistClaudeSessionContexts as persistClaudeContexts,
  readProjectionWatermark,
  repairBrokenIngestionCursor,
  withCanonicalWriterLease as withProjectorLease,
  yieldEventLoop
} from "./event-log-projector.js";
import { createSqliteSyncRunStore } from "./sync-run-store.js";
import { installHttpSecurity } from "./http-security.js";
import { registerCoreRoutes } from "./core-routes.js";
import { persistCursorAccountUsage } from "./cursor-account-usage.js";
import { startCursorOfficialRefreshLoop } from "./cursor-official-refresh.js";
import { collectCodexKeyUsage } from "./official-key-usage.js";
import { runIsolatedSourceRefreshTasks, startSourceLightRefreshLoop } from "./source-light-refresh.js";
import type { BuildAppInput, MetricsDatabase } from "./core-types.js";

/** Vendors covered by dedicated light refresh loops (not the heavy periodic coordinator). */
const LIGHT_REFRESH_VENDORS = new Set(["cursor", "codex", "opencode", "zcode", "kimicode", "dsh", "mimo"]);

export { createEventLogSynchronizer } from "./event-log-projector.js";

type MetricsApp = ReturnType<typeof Fastify> & {
  db: MetricsDatabase;
  syncCoordinator: SyncCoordinator;
};

export function resolveDefaultDbPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../../data/sqlite/metrics.sqlite", moduleUrl));
}

export function resolveDefaultEventLogPath(moduleUrl: string): string {
  return fileURLToPath(new URL("../../../data/events/events.jsonl", moduleUrl));
}




export function buildApp(input: BuildAppInput): MetricsApp {
  mkdirSync(dirname(input.dbPath), { recursive: true });

  const db = new Database(input.dbPath) as unknown as MetricsDatabase;

  // WAL allows readers (API requests) and the writer (ingestion) to work
  // concurrently instead of blocking on the default rollback journal. WAL mode
  // itself persists in the database header; busy_timeout/synchronous apply per
  // connection and are set on every open. busy_timeout makes concurrent writes
  // wait instead of failing immediately with SQLITE_BUSY (important since
  // better-sqlite3 is synchronous).
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

  const agentPaths = input.repoRoot ? getAgentMetricsPaths(input.repoRoot) : null;

  initializeLegacySchema(db);
  runDomainMigrations(db as unknown as SqliteDatabaseLike, input.now ?? (() => new Date()));

  const app = Fastify();
  const metricsApp = Object.assign(app, {
    db,
    syncCoordinator: null as unknown as SyncCoordinator
  });
  installHttpSecurity(app, {
    trustedOrigins: input.trustedOrigins,
    localAccessToken: input.localAccessToken
  });
  const canonicalEventLogPath = input.eventLogPath ?? agentPaths?.eventLogPath;
  // Note: broken ingestion cursors are repaired in server.ts before listen.
  // Startup catch-up ingest is intentionally omitted (blocks /api/health).
  const syncEventLog = canonicalEventLogPath
    ? createIncrementalEventLogSynchronizer({
        eventLogPath: canonicalEventLogPath,
        ingest: async () =>
          projectEventLog({
            db: db as unknown as import("./event-log-projector.js").EventProjectorDatabase,
            eventLogPath: canonicalEventLogPath,
            logger: metricsApp.log
          })
      })
    : null;

  const projectAfterSourceSync = async (): Promise<SyncResult> => {
    // Yield before synchronous better-sqlite3 projection so /api/health can answer.
    await yieldEventLoop();
    const before = readProjectionWatermark(
      db as unknown as import("./event-log-projector.js").EventProjectorDatabase
    );
    if (syncEventLog !== null) {
      await syncEventLog();
    }
    await yieldEventLoop();
    const after = readProjectionWatermark(
      db as unknown as import("./event-log-projector.js").EventProjectorDatabase
    );
    const projectedUniqueEvents = Math.max(0, after - before);
    return {
      discoveredRecords: projectedUniqueEvents,
      committedUniqueEvents: projectedUniqueEvents,
      projectedUniqueEvents,
      projectionWatermark: after
    };
  };
  const runWithCanonicalWriterLease = <T>(
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> =>
    withProjectorLease({
      lockPath: `${canonicalEventLogPath ?? "canonical-events"}.writer.lock`,
      canonicalPath: canonicalEventLogPath ?? "canonical-events",
      signal,
      operation
    });

  const sourceSyncAdapters: SyncAdapter[] = [];
  if (agentPaths !== null && canonicalEventLogPath !== undefined) {
    if (process.env.AGENT_METRICS_CORE_TRANSCRIPT_SYNC !== "0") {
      sourceSyncAdapters.push({
        adapterInstanceId: "claude-transcript@claude:default",
        sourceInstanceId: "claude:default",
        sourceAdapter: "claude-transcript",
        sourceVendor: "claude-code",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            const result = await syncKnownClaudeTranscripts({
              manifestPath: agentPaths.transcriptManifestPath,
              eventLogPath: canonicalEventLogPath,
              transcriptCursorPath: agentPaths.transcriptCursorPath,
              transcriptLedgerPath: agentPaths.transcriptLedgerPath,
              discoveryRoots: []
            });
            persistClaudeContexts(db as unknown as import("./event-log-projector.js").EventProjectorDatabase, result.sessionContexts);
            return projectAfterSourceSync();
          })
        }
      );
    }

    sourceSyncAdapters.push(
      {
        adapterInstanceId: "opencode-db@opencode:default",
        sourceInstanceId: "opencode:default",
        sourceAdapter: "opencode-db",
        sourceVendor: "opencode",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            await syncOpenCodeDatabase({
              eventLogPath: canonicalEventLogPath,
              cursorPath: agentPaths.opencodeCursorPath,
              ledgerPath: agentPaths.opencodeLedgerPath
            });
            return projectAfterSourceSync();
          })
        }
      ,
      {
        adapterInstanceId: "zcode-db@zcode:default",
        sourceInstanceId: "zcode:default",
        sourceAdapter: "zcode-db",
        sourceVendor: "zcode",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            await syncZCodeDatabase({
              eventLogPath: canonicalEventLogPath,
              cursorPath: agentPaths.zcodeCursorPath,
              ledgerPath: agentPaths.zcodeLedgerPath
            });
            return projectAfterSourceSync();
          })
        }
      ,
      {
        adapterInstanceId: "kimicode-wire@kimicode:default",
        sourceInstanceId: "kimicode:default",
        sourceAdapter: "kimicode-wire",
        sourceVendor: "kimicode",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            await syncKimicodeSessions({
              eventLogPath: canonicalEventLogPath,
              cursorPath: agentPaths.kimicodeCursorPath,
              ledgerPath: agentPaths.kimicodeLedgerPath
            });
            return projectAfterSourceSync();
          })
        }
      ,
      {
        adapterInstanceId: "mimo-db@mimo:default",
        sourceInstanceId: "mimo:default",
        sourceAdapter: "mimo-db",
        sourceVendor: "mimo",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            await syncMiMoDatabase({
              eventLogPath: canonicalEventLogPath,
              cursorPath: agentPaths.mimoCursorPath,
              ledgerPath: agentPaths.mimoLedgerPath
            });
            return projectAfterSourceSync();
          })
        }
      ,
      {
        adapterInstanceId: "dsh-jsonl@dsh:default",
        sourceInstanceId: "dsh:default",
        sourceAdapter: "dsh-jsonl",
        sourceVendor: "dsh",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            await syncDshSessions({
              eventLogPath: canonicalEventLogPath,
              cursorPath: agentPaths.dshCursorPath,
              ledgerPath: agentPaths.dshLedgerPath
            });
            return projectAfterSourceSync();
          })
        }
      ,
      {
        adapterInstanceId: "cursor-ide@cursor:default",
        sourceInstanceId: "cursor:default",
        sourceAdapter: "cursor-ide",
        sourceVendor: "cursor",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            await syncCursorArtifacts({
              eventLogPath: canonicalEventLogPath,
              cursorPath: agentPaths.cursorIdeStatePath,
              ledgerPath: agentPaths.cursorIdeLedgerPath
            });
            const officialUsage = await syncCursorOfficialUsage({
              sourceInstanceId: "cursor:default",
              timeZone: "Asia/Shanghai"
            });
            if (officialUsage) {
              persistCursorAccountUsage(db as unknown as import("./domain-types.js").SqliteDatabaseLike, officialUsage);
            }
            return projectAfterSourceSync();
          })
        }
      ,
      {
        adapterInstanceId: "codex-rollout@codex:default",
        sourceInstanceId: "codex:default",
        sourceAdapter: "codex-rollout",
        sourceVendor: "codex",
        enabled: true,
        sync: async ({ signal }) =>
          runWithCanonicalWriterLease(signal, async () => {
            await syncCodexRollouts({
              eventLogPath: canonicalEventLogPath,
              cursorPath: agentPaths.codexCursorPath,
              ledgerPath: agentPaths.codexLedgerPath
            });
            return projectAfterSourceSync();
          })
        }
    );
  }

  const syncCoordinator = new SyncCoordinator(sourceSyncAdapters, {
    maxConcurrency: 2,
    now: input.now,
    persistence: createSqliteSyncRunStore(db as unknown as SqliteDatabaseLike)
  });
  metricsApp.syncCoordinator = syncCoordinator;
  let cursorOfficialRefresh: ReturnType<typeof startCursorOfficialRefreshLoop> | null = null;
  let sourceLightRefresh: ReturnType<typeof startSourceLightRefreshLoop> | null = null;

  app.addHook("onClose", async () => {
    cursorOfficialRefresh?.stop();
    cursorOfficialRefresh = null;
    sourceLightRefresh?.stop();
    sourceLightRefresh = null;
    await syncCoordinator.shutdown();
    db.close();
  });

  app.addHook("onReady", async () => {
    if (sourceSyncAdapters.length > 0) {
      const initialAdapterIds = sourceSyncAdapters
        .map((adapter) => adapter.adapterInstanceId)
        .filter((adapterInstanceId) => {
          const state = syncCoordinator.getStatus(adapterInstanceId);
          return state?.lastSuccessfulAt === null;
        });
      const periodicAdapterIds = sourceSyncAdapters
        .filter((adapter) => !LIGHT_REFRESH_VENDORS.has(adapter.sourceVendor))
        .map((adapter) => adapter.adapterInstanceId);
      if (initialAdapterIds.length > 0) {
        // Coordinator runs are asynchronous; accepting them after routes are ready
        // keeps API startup non-blocking while recording initial run state.
        syncCoordinator.startInitialSync(initialAdapterIds);
      }
      if (periodicAdapterIds.length > 0) {
        syncCoordinator.startPeriodicSync(undefined, periodicAdapterIds);
      }
      // Always refresh Cursor official day tokens lightly so the widget stays current.
      cursorOfficialRefresh = startCursorOfficialRefreshLoop(
        db as unknown as import("./domain-types.js").SqliteDatabaseLike,
        {
          timeZone: "Asia/Shanghai",
          log: metricsApp.log
        }
      );
      // Seed official key usage (Codex rate limits) at startup; the light
      // refresh loop below keeps the snapshots current afterwards.
      void collectCodexKeyUsage(db as unknown as import("./domain-types.js").SqliteDatabaseLike, {
        log: metricsApp.log
      }).catch((error: unknown) => {
        metricsApp.log.warn(`official key usage collection failed: ${String(error)}`);
      });
      if (agentPaths !== null && canonicalEventLogPath !== undefined) {
        const eventLogPath = canonicalEventLogPath;
        const paths = agentPaths;
        sourceLightRefresh = startSourceLightRefreshLoop(
          async ({ reconcileRecent }) => {
            // Do not contend with manual/periodic coordinator runs for the writer lease.
            if (syncCoordinator.hasActiveWork()) {
              return;
            }
            const succeededAdapterIds: string[] = [];
            await runWithCanonicalWriterLease(new AbortController().signal, async () => {
              await runIsolatedSourceRefreshTasks(
                [
                  {
                    id: "codex-rollout@codex:default",
                    run: () =>
                      syncCodexRollouts({
                        eventLogPath,
                        cursorPath: paths.codexCursorPath,
                        ledgerPath: paths.codexLedgerPath,
                        reconcileRecent
                      })
                  },
                  {
                    id: "opencode-db@opencode:default",
                    run: () =>
                      syncOpenCodeDatabase({
                        eventLogPath,
                        cursorPath: paths.opencodeCursorPath,
                        ledgerPath: paths.opencodeLedgerPath
                      })
                  },
                  {
                    id: "zcode-db@zcode:default",
                    run: () =>
                      syncZCodeDatabase({
                        eventLogPath,
                        cursorPath: paths.zcodeCursorPath,
                        ledgerPath: paths.zcodeLedgerPath
                      })
                  },
                  {
                    id: "kimicode-wire@kimicode:default",
                    run: () =>
                      syncKimicodeSessions({
                        eventLogPath,
                        cursorPath: paths.kimicodeCursorPath,
                        ledgerPath: paths.kimicodeLedgerPath
                      })
                  },
                  {
                    id: "mimo-db@mimo:default",
                    run: () =>
                      syncMiMoDatabase({
                        eventLogPath,
                        cursorPath: paths.mimoCursorPath,
                        ledgerPath: paths.mimoLedgerPath
                      })
                  },
                  {
                    id: "dsh-jsonl@dsh:default",
                    run: () =>
                      syncDshSessions({
                        eventLogPath,
                        cursorPath: paths.dshCursorPath,
                        ledgerPath: paths.dshLedgerPath
                      })
                  },
                  {
                    id: "cursor-ide@cursor:default",
                    run: () =>
                      syncCursorArtifacts({
                        eventLogPath,
                        cursorPath: paths.cursorIdeStatePath,
                        ledgerPath: paths.cursorIdeLedgerPath
                      })
                  }
                ],
                {
                  log: metricsApp.log,
                  onSuccess: (id) => {
                    succeededAdapterIds.push(id);
                  }
                }
              );
              if (succeededAdapterIds.length > 0) {
                await projectAfterSourceSync();
              }
            });
            for (const adapterId of succeededAdapterIds) {
              syncCoordinator.markBackgroundSuccess(adapterId);
            }
            // Keep official key usage snapshots fresh alongside the rollout sync.
            try {
              await collectCodexKeyUsage(
                db as unknown as import("./domain-types.js").SqliteDatabaseLike,
                { log: metricsApp.log }
              );
            } catch (error) {
              metricsApp.log.warn(`official key usage collection failed: ${String(error)}`);
            }
          },
          { log: metricsApp.log }
        );
      }
      return;
    }

    if (syncEventLog !== null) {
      await projectAfterSourceSync();
    }
  });

  registerCoreRoutes({ app, db, input, syncCoordinator });

  return metricsApp;
}

export async function ingestEventLog(input: {
  app: MetricsApp;
  eventLogPath: string;
}): Promise<{ atEnd: boolean }> {
  return projectEventLog({
    db: input.app.db as unknown as import("./event-log-projector.js").EventProjectorDatabase,
    eventLogPath: input.eventLogPath,
    logger: input.app.log
  });
}
