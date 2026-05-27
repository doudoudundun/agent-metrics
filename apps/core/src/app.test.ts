import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import { buildApp, ingestEventLog, resolveDefaultDbPath } from "./app.js";

let dbPath: string;
let logPath: string;

const may25AppInput = {
  now: () => new Date("2026-05-25T09:00:00.000Z"),
  timezone: "UTC",
  offsetMinutes: 0
};

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-metrics-core-"));
  dbPath = join(root, "metrics.sqlite");
  logPath = join(root, "events.jsonl");
});

describe("ingestEventLog", () => {
  it("stores tool and code edit events into SQLite-backed overview rows", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    await appendJsonLine(logPath, {
      event_id: "evt_3",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:02.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.failed",
      tool_name: "Write",
      status: "failed",
      duration_ms: 21
    });

    await appendJsonLine(logPath, {
      event_id: "evt_4",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:03.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "code.edit.applied",
      tool_name: "Edit",
      files_changed: ["src/app.ts", "src/index.ts"],
      file_count: 2,
      insertions: 12,
      deletions: 4,
      edit_operation_count: 1
    });

    const app = buildApp({ dbPath, ...may25AppInput });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      affectedFileCount: 2,
      deletions: 4,
      editOperationCount: 1,
      failedExecutions: 1,
      insertions: 12,
      totalToolCalls: 2,
      successfulExecutions: 1,
      successRate: 0.5,
      sessionCount: 1
    });

    await app.close();
  });

  it("creates the SQLite parent directory and closes the database on shutdown", async () => {
    const nestedDbPath = join(tmpdir(), "agent-metrics-core-nested", randomUUID(), "sqlite", "metrics.sqlite");

    const app = buildApp({ dbPath: nestedDbPath });

    expect(existsSync(dirname(nestedDbPath))).toBe(true);

    await app.close();

    expect(() => app.db.prepare("SELECT 1").get()).toThrow();
  });

  it("resolves the default database path from the repository root", () => {
    const serverModuleUrl = new URL("./server.ts", import.meta.url).href;

    expect(resolveDefaultDbPath(serverModuleUrl)).toBe(
      fileURLToPath(new URL("../../../data/sqlite/metrics.sqlite", serverModuleUrl))
    );
  });

  it("migrates a legacy sessions table before ingest and overview queries", async () => {
    const { default: LegacyDatabase } = await import("better-sqlite3");
    const legacyDb = new LegacyDatabase(dbPath);

    legacyDb.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        workspace_path TEXT NOT NULL
      );
    `);
    legacyDb.close();

    await appendJsonLine(logPath, {
      event_id: "evt_legacy_1",
      session_id: "ses_legacy_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    const app = buildApp({ dbPath, ...may25AppInput });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionCount: 1
    });

    await app.close();
  });
});

describe("core api", () => {
  const scopedNow = new Date("2026-05-27T10:30:00.000Z");
  const scopedAppInput = {
    now: () => scopedNow,
    timezone: "Asia/Shanghai",
    offsetMinutes: 480
  };

  async function seedScopedAggregateDataset(): Promise<void> {
    const workspacePath = "D:/projects/dev/agent-metrics";

    for (const event of [
      {
        event_id: "evt_old_started",
        session_id: "ses_old",
        timestamp: "2026-05-24T15:00:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "session.started"
      },
      {
        event_id: "evt_old_tool",
        session_id: "ses_old",
        timestamp: "2026-05-24T15:01:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "tool.succeeded",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 10
      },
      {
        event_id: "evt_old_edit",
        session_id: "ses_old",
        timestamp: "2026-05-24T15:02:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "code.edit.applied",
        tool_name: "Edit",
        files_changed: ["old.ts"],
        file_count: 1,
        insertions: 1,
        deletions: 0,
        edit_operation_count: 1
      },
      {
        event_id: "evt_week_started",
        session_id: "ses_week",
        timestamp: "2026-05-25T08:00:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "session.started"
      },
      {
        event_id: "evt_week_tool",
        session_id: "ses_week",
        timestamp: "2026-05-25T08:01:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "tool.failed",
        tool_name: "Write",
        status: "failed",
        duration_ms: 20
      },
      {
        event_id: "evt_week_edit",
        session_id: "ses_week",
        timestamp: "2026-05-25T08:02:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "code.edit.applied",
        tool_name: "Edit",
        files_changed: ["week.ts", "shared.ts"],
        file_count: 2,
        insertions: 2,
        deletions: 1,
        edit_operation_count: 1
      },
      {
        event_id: "evt_today_started",
        session_id: "ses_today",
        timestamp: "2026-05-27T01:00:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "session.started"
      },
      {
        event_id: "evt_today_tool",
        session_id: "ses_today",
        timestamp: "2026-05-27T01:01:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "tool.succeeded",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 30
      },
      {
        event_id: "evt_today_edit",
        session_id: "ses_today",
        timestamp: "2026-05-27T01:02:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: workspacePath,
        type: "code.edit.applied",
        tool_name: "Edit",
        files_changed: ["today.ts", "shared.ts", "new.ts"],
        file_count: 3,
        insertions: 3,
        deletions: 2,
        edit_operation_count: 1
      }
    ]) {
      await appendJsonLine(logPath, event);
    }
  }

  it("ingests the configured event log automatically before overview reads", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_runtime_1",
      session_id: "ses_runtime_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_runtime_2",
      session_id: "ses_runtime_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    const app = buildApp({ dbPath, eventLogPath: logPath, ...may25AppInput });
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionCount: 1,
      totalToolCalls: 1
    });

    await app.close();
  });

  it("returns scoped overview metrics and metadata", async () => {
    await seedScopedAggregateDataset();

    const app = buildApp({ dbPath, ...scopedAppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const week = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=week" });
    const day = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });
    const lifetime = await app.inject({ method: "GET", url: "/api/overview?mode=lifetime&range=week" });

    expect(week.statusCode).toBe(200);
    expect(week.json()).toEqual({
      sessionCount: 2,
      totalToolCalls: 2,
      successfulExecutions: 1,
      failedExecutions: 1,
      successRate: 0.5,
      editOperationCount: 2,
      affectedFileCount: 5,
      insertions: 5,
      deletions: 3,
      mode: "calendar",
      range: "week",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-24T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    });
    expect(day.statusCode).toBe(200);
    expect(day.json()).toMatchObject({
      sessionCount: 1,
      totalToolCalls: 1,
      affectedFileCount: 3,
      insertions: 3,
      deletions: 2,
      mode: "calendar",
      range: "day",
      windowStart: "2026-05-26T16:00:00.000Z"
    });
    expect(lifetime.statusCode).toBe(200);
    expect(lifetime.json()).toMatchObject({
      sessionCount: 3,
      totalToolCalls: 3,
      affectedFileCount: 6,
      mode: "lifetime",
      range: "week",
      windowStart: null,
      windowEnd: null
    });

    await app.close();
  });

  it("returns scoped tool rankings and metadata", async () => {
    await seedScopedAggregateDataset();

    const app = buildApp({ dbPath, ...scopedAppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const response = await app.inject({ method: "GET", url: "/api/tools?mode=calendar&range=week" });
    const rollingWeek = await app.inject({ method: "GET", url: "/api/tools?mode=rolling&range=week" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rows: [
        { toolName: "Read", count: 1, failures: 0, averageDurationMs: 30 },
        { toolName: "Write", count: 1, failures: 1, averageDurationMs: 20 }
      ],
      mode: "calendar",
      range: "week",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-24T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    });
    expect(rollingWeek.statusCode).toBe(200);
    expect(rollingWeek.json()).toEqual({
      rows: [
        { toolName: "Read", count: 2, failures: 0, averageDurationMs: 20 },
        { toolName: "Write", count: 1, failures: 1, averageDurationMs: 20 }
      ],
      mode: "rolling",
      range: "week",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-20T10:30:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    });

    await app.close();
  });

  it("returns scoped sessions and metadata", async () => {
    await seedScopedAggregateDataset();

    const app = buildApp({ dbPath, ...scopedAppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const response = await app.inject({ method: "GET", url: "/api/sessions?mode=calendar&range=day" });
    const month = await app.inject({ method: "GET", url: "/api/sessions?mode=calendar&range=month" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rows: [{ sessionId: "ses_today", workspacePath: "D:/projects/dev/agent-metrics" }],
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    });
    expect(month.statusCode).toBe(200);
    expect(month.json()).toEqual({
      rows: [
        { sessionId: "ses_today", workspacePath: "D:/projects/dev/agent-metrics" },
        { sessionId: "ses_week", workspacePath: "D:/projects/dev/agent-metrics" },
        { sessionId: "ses_old", workspacePath: "D:/projects/dev/agent-metrics" }
      ],
      mode: "calendar",
      range: "month",
      timezone: "Asia/Shanghai",
      windowStart: "2026-04-30T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z"
    });

    await app.close();
  });

  it("returns tool, session, and export payloads", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    const app = buildApp({ dbPath, ...may25AppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const tools = await app.inject({ method: "GET", url: "/api/tools" });
    const sessions = await app.inject({ method: "GET", url: "/api/sessions" });
    const json = await app.inject({ method: "GET", url: "/api/exports/json" });
    const csv = await app.inject({ method: "GET", url: "/api/exports/csv" });

    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      rows: [{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }],
      mode: "calendar",
      range: "day"
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toMatchObject({
      rows: [{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }],
      mode: "calendar",
      range: "day"
    });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual([{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }]);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("toolName,count,failures,averageDurationMs");

    await app.close();
  });

  it("returns a session detail timeline", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_detail_1",
      session_id: "ses_detail_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_detail_2",
      session_id: "ses_detail_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    await appendJsonLine(logPath, {
      event_id: "evt_detail_3",
      session_id: "ses_detail_1",
      timestamp: "2026-05-25T08:00:02.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "code.edit.applied",
      tool_name: "Edit",
      files_changed: ["src/app.ts"],
      file_count: 1,
      insertions: 3,
      deletions: 1,
      edit_operation_count: 1
    });

    await appendJsonLine(logPath, {
      event_id: "evt_detail_4",
      session_id: "ses_detail_1",
      timestamp: "2026-05-25T08:00:03.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.ended",
      exit_code: 0,
      duration_ms: 42
    });

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/sessions/ses_detail_1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId: "ses_detail_1",
      timeline: [
        {
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "session.started",
          toolName: "",
          status: "started",
          durationMs: 0
        },
        {
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "tool.succeeded",
          toolName: "Read",
          status: "succeeded",
          durationMs: 14
        },
        {
          filesChanged: ["src/app.ts"],
          insertions: 3,
          deletions: 1,
          type: "code.edit.applied",
          toolName: "Edit",
          status: "applied",
          durationMs: 0
        },
        {
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "session.ended",
          toolName: "",
          status: "ended",
          durationMs: 0
        }
      ]
    });

    await app.close();
  });

  it("returns 404 for a missing session detail request", async () => {
    const app = buildApp({ dbPath });
    const response = await app.inject({ method: "GET", url: "/api/sessions/does-not-exist" });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
