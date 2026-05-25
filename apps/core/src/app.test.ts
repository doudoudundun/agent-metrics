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

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      affectedFileCount: 2,
      deletions: 4,
      editOperationCount: 1,
      estimatedTokens: 0,
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

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      estimatedTokens: 0,
      sessionCount: 1
    });

    await app.close();
  });
});

describe("core api", () => {
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

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });

    const tools = await app.inject({ method: "GET", url: "/api/tools" });
    const sessions = await app.inject({ method: "GET", url: "/api/sessions" });
    const json = await app.inject({ method: "GET", url: "/api/exports/json" });
    const csv = await app.inject({ method: "GET", url: "/api/exports/csv" });

    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toEqual([{ toolName: "Read", count: 1, failures: 0, averageDurationMs: 14 }]);
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual([{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }]);
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

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/sessions/ses_detail_1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId: "ses_detail_1",
      timeline: [
        {
          type: "tool.succeeded",
          toolName: "Read",
          status: "succeeded",
          durationMs: 14
        }
      ]
    });

    await app.close();
  });
});
