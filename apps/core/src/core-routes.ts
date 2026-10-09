import { toCsv, toJson } from "@agent-metrics/export-kit";
import { buildOverviewMetrics } from "@agent-metrics/metrics-engine";
import {
  ApiErrorCode,
  ApiErrorResponseSchema,
  CursorAccountUsageResponseSchema,
  HealthResponseSchema,
  ManualSyncRequestSchema,
  ManualSyncResponseSchema,
  OverviewResponseSchema,
  SessionDetailResponseSchema,
  SessionsResponseSchema,
  SyncRunResponseSchema,
  SyncStatusResponseSchema,
  TokenTrendResponseSchema,
  ToolsResponseSchema,
  WidgetSnapshotResponseSchema
} from "@agent-metrics/contracts";
import type { FastifyInstance } from "fastify";
import type { SqliteDatabaseLike } from "./domain-migrations.js";
import {
  isSessionListCursor,
  isTimelineCursor,
  selectCanonicalSessionDetail,
  selectCanonicalSessions,
  selectWidgetSnapshot
} from "./canonical-queries.js";
import {
  selectCursorAccountUsage,
  toCursorAccountUsageResponse
} from "./cursor-account-usage.js";
import {
  selectOverviewRows,
  selectTokensByModel,
  selectToolRanking
} from "./aggregate-queries.js";
import {
  selectProviderBreakdown,
  selectSourceBreakdown,
  selectTokenTrend
} from "./session-queries.js";
import {
  createPageCursor,
  InvalidCursorError,
  readPageCursor,
  readPageLimit,
  resolveRequestScope,
  resolveSourceVendor,
  withScopeMetadata,
  type ScopeInput
} from "./query-support.js";
import { InvalidTimeScopeError } from "./time-scope.js";
import {
  SyncCoordinator,
  SyncCoordinatorError
} from "./sync-coordinator.js";
import type { MetricsDatabase } from "./core-types.js";
import { registerLegacyRoutes } from "./legacy-routes.js";

type ErrorReply = {
  code(statusCode: number): ErrorReply;
  send(payload: unknown): unknown;
};


type RouteInput = {
  app: FastifyInstance;
  db: MetricsDatabase;
  input: ScopeInput;
  syncCoordinator: SyncCoordinator;
};

function sendApiError(
  reply: ErrorReply,
  requestId: string,
  code: string,
  message: string,
  statusCode: number
): unknown {
  reply.code(statusCode);
  return reply.send(
    ApiErrorResponseSchema.parse({
      error: {
        code,
        message,
        requestId
      }
    })
  );
}

function sendSyncError(reply: ErrorReply, requestId: string, error: unknown): unknown {
  if (isValidationError(error)) {
    return sendApiError(reply, requestId, ApiErrorCode.INVALID_REQUEST, "Invalid request.", 400);
  }

  if (error instanceof SyncCoordinatorError) {
    const knownErrors: Record<string, { code: string; message: string; statusCode: number }> = {
      ADAPTER_NOT_FOUND: {
        code: ApiErrorCode.ADAPTER_NOT_FOUND,
        message: "Adapter not found.",
        statusCode: 404
      },
      ADAPTER_DISABLED: {
        code: ApiErrorCode.ADAPTER_DISABLED,
        message: "Adapter is disabled.",
        statusCode: 409
      },
      SYNC_SHUTTING_DOWN: {
        code: ApiErrorCode.SYNC_SHUTTING_DOWN,
        message: "Synchronization is shutting down.",
        statusCode: 503
      }
    };
    const mapped = knownErrors[error.code] ?? {
      code: "SYNC_FAILED",
      message: "Synchronization request failed.",
      statusCode: 503
    };
    return sendApiError(reply, requestId, mapped.code, mapped.message, mapped.statusCode);
  }

  return sendApiError(reply, requestId, "SYNC_FAILED", "Synchronization request failed.", 503);
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZodError";
}


export function registerCoreRoutes({ app, db, input, syncCoordinator }: RouteInput): void {
  function readScope(request: { query: unknown; id: string }, reply: ErrorReply) {
    try {
      return resolveRequestScope(request.query, input);
    } catch (error) {
      if (error instanceof InvalidTimeScopeError) {
        sendApiError(reply, request.id, ApiErrorCode.INVALID_REQUEST, error.message, 400);
        return null;
      }
      throw error;
    }
  }

  app.get("/api/health", async (_, reply) => {
    reply.header("cache-control", "no-store");
    return HealthResponseSchema.parse({
      status: "ok",
      apiVersion: 2,
      eventSchemaVersion: 2
    });
  });

  app.get("/api/widget-snapshot", async (_, reply) => {
    reply.header("cache-control", "no-store");
    return WidgetSnapshotResponseSchema.parse(
      selectWidgetSnapshot(db as unknown as SqliteDatabaseLike, input.now?.() ?? new Date())
    );
  });

  app.get("/api/sync/status", async (_, reply) => {
    reply.header("cache-control", "no-store");
    return SyncStatusResponseSchema.parse(syncCoordinator.getStatus());
  });

  app.get("/api/sync/runs/:runId", async (request, reply) => {
    const params = request.params as { runId: string };
    const run = syncCoordinator.getRun(params.runId);
    if (run === null) {
      return sendApiError(
        reply,
        request.id,
        ApiErrorCode.SYNC_RUN_NOT_FOUND,
        "Sync run not found.",
        404
      );
    }

    reply.header("cache-control", "no-store");
    return SyncRunResponseSchema.parse(run);
  });

  app.post("/api/sync", async (request, reply) => {
    try {
      ManualSyncRequestSchema.parse(request.body ?? {});
      const response = syncCoordinator.manualSync();
      reply.code(202);
      return ManualSyncResponseSchema.parse(response);
    } catch (error) {
      return sendSyncError(reply, request.id, error);
    }
  });

  app.post("/api/sync/:adapterInstanceId", async (request, reply) => {
    const params = request.params as { adapterInstanceId: string };
    try {
      ManualSyncRequestSchema.parse(request.body ?? {});
      const response = syncCoordinator.manualSync(params.adapterInstanceId);
      reply.code(202);
      return ManualSyncResponseSchema.parse(response);
    } catch (error) {
      return sendSyncError(reply, request.id, error);
    }
  });

  app.get("/api/overview", async (request, reply) => {
    const scope = readScope(request, reply);
    if (!scope) {
      return;
    }
    const sourceVendor = resolveSourceVendor(request.query);
    const overviewRows = selectOverviewRows(db, scope, sourceVendor);
    const tokensByModel = selectTokensByModel(db, scope, sourceVendor);

    const response = withScopeMetadata(
      {
        ...buildOverviewMetrics({
          sessions: overviewRows.sessions,
          toolEvents: overviewRows.toolEvents,
          prompts: overviewRows.prompts,
          responses: overviewRows.responses,
          tokenUsage: overviewRows.tokenUsage,
          codeEdits: overviewRows.codeEdits
        }),
        tokensByModel,
        sourceBreakdown: selectSourceBreakdown(db, scope, sourceVendor),
        providerBreakdown: selectProviderBreakdown(db, scope, sourceVendor).map((row) => ({
          ...row,
          providerId: row.providerId ?? "unknown"
        })),
        totalCostUsd: tokensByModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
      },
      scope
    );
    return OverviewResponseSchema.parse(response);
  });

  app.get("/api/cursor/account-usage", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const query = request.query as { sourceInstanceId?: string };
    const sourceInstanceId =
      typeof query.sourceInstanceId === "string" && query.sourceInstanceId.length > 0
        ? query.sourceInstanceId
        : "cursor:default";
    const row = selectCursorAccountUsage(db as unknown as SqliteDatabaseLike, sourceInstanceId);
    if (row === null) {
      return sendApiError(
        reply,
        request.id,
        ApiErrorCode.NOT_READY,
        "Cursor account usage has not been synced yet.",
        404
      );
    }

    return CursorAccountUsageResponseSchema.parse(toCursorAccountUsageResponse(row));
  });

  app.get("/api/token-trend", async (request, reply) => {
    const scope = readScope(request, reply);
    if (!scope) {
      return;
    }
    const sourceVendor = resolveSourceVendor(request.query);

    return TokenTrendResponseSchema.parse(
      withScopeMetadata({ rows: selectTokenTrend(db, scope, sourceVendor) }, scope)
    );
  });

  app.get("/api/tools", async (request, reply) => {
    const scope = readScope(request, reply);
    if (!scope) {
      return;
    }
    const sourceVendor = resolveSourceVendor(request.query);

    return ToolsResponseSchema.parse(
      withScopeMetadata({ rows: selectToolRanking(db, scope, sourceVendor) }, scope)
    );
  });

  app.get("/api/sessions", async (request, reply) => {
    const scope = readScope(request, reply);
    if (!scope) {
      return;
    }
    const sourceVendor = resolveSourceVendor(request.query);
    const limit = readPageLimit(request.query);
    if (limit === null) {
      return sendApiError(reply, request.id, ApiErrorCode.INVALID_REQUEST, "Invalid request.", 400);
    }
    const cursorFilter = {
      kind: "sessions",
      mode: scope.mode,
      range: scope.range,
      timezone: scope.timezone,
      windowStart: scope.windowStart,
      windowEnd: scope.windowEnd,
      sourceVendor
    };
    try {
      const page = selectCanonicalSessions(db as unknown as SqliteDatabaseLike, {
        scope,
        sourceVendor,
        limit,
        cursor: readPageCursor(request.query, cursorFilter, isSessionListCursor),
        createCursor: (sortKey) => createPageCursor(cursorFilter, sortKey)
      });
      return SessionsResponseSchema.parse(withScopeMetadata(page, scope));
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return sendApiError(reply, request.id, ApiErrorCode.INVALID_CURSOR, "Invalid cursor.", 400);
      }
      throw error;
    }
  });

  app.get("/api/sources/:sourceInstanceId/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sourceInstanceId: string; sessionId: string };
    const limit = readPageLimit(request.query);
    if (limit === null) {
      return sendApiError(reply, request.id, ApiErrorCode.INVALID_REQUEST, "Invalid request.", 400);
    }
    const scope = readScope(request, reply);
    if (!scope) {
      return;
    }
    const cursorFilter = {
      kind: "session-timeline",
      mode: scope.mode,
      range: scope.range,
      timezone: scope.timezone,
      windowStart: scope.windowStart,
      windowEnd: scope.windowEnd,
      sourceInstanceId: params.sourceInstanceId,
      sessionId: params.sessionId
    };
    let detail;
    try {
      detail = selectCanonicalSessionDetail(db as unknown as SqliteDatabaseLike, {
        sourceInstanceId: params.sourceInstanceId,
        sessionId: params.sessionId,
        scope,
        limit,
        cursor: readPageCursor(request.query, cursorFilter, isTimelineCursor),
        createCursor: (sortKey) => createPageCursor(cursorFilter, sortKey)
      });
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return sendApiError(reply, request.id, ApiErrorCode.INVALID_CURSOR, "Invalid cursor.", 400);
      }
      throw error;
    }
    if (detail === null) {
      return sendApiError(reply, request.id, ApiErrorCode.SESSION_NOT_FOUND, "Session not found.", 404);
    }
    return SessionDetailResponseSchema.parse(detail);
  });


  app.get("/api/exports/json", async (request, reply) => {
    const scope = readScope(request, reply);
    if (!scope) {
      return;
    }
    const sourceVendor = resolveSourceVendor(request.query);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="tools.json"');
    return toJson(selectToolRanking(db, scope, sourceVendor));
  });

  app.get("/api/exports/csv", async (request, reply) => {
    const scope = readScope(request, reply);
    if (!scope) {
      return;
    }
    const sourceVendor = resolveSourceVendor(request.query);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="tools.csv"');
    return toCsv(selectToolRanking(db, scope, sourceVendor));
  });

  registerLegacyRoutes({ app, db });
}
