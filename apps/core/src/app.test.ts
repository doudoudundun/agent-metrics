import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as claudeAdapter from "@agent-metrics/adapters-claude";
import { recordClaudeTranscriptReference } from "@agent-metrics/adapters-claude";
import { getAgentMetricsPaths } from "@agent-metrics/shared-utils";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import {
  buildApp,
  createEventLogSynchronizer,
  ingestEventLog,
  resolveDefaultDbPath
} from "./app.js";

let dbPath: string;
let logPath: string;

const may25AppInput = {
  now: () => new Date("2026-05-25T09:00:00.000Z"),
  timezone: "UTC",
  offsetMinutes: 0
};

const scopedNow = new Date("2026-05-27T10:30:00.000Z");
const scopedAppInput = {
  now: () => scopedNow,
  timezone: "Asia/Shanghai",
  offsetMinutes: 480
};

beforeEach(async () => {
  vi.restoreAllMocks();
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

  it("coalesces concurrent sync requests and skips unchanged event logs", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_sync_1",
      session_id: "ses_sync_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    let ingestCount = 0;
    let releaseIngest: (() => void) | null = null;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseIngest = resolve;
    });
    const syncEventLog = createEventLogSynchronizer({
      eventLogPath: logPath,
      ingest: async () => {
        ingestCount += 1;
        await waitForRelease;
      }
    });

    const firstSync = syncEventLog();
    const secondSync = syncEventLog();

    await waitForCondition(() => ingestCount === 1);
    releaseIngest?.();
    await Promise.all([firstSync, secondSync]);

    expect(ingestCount).toBe(1);

    await syncEventLog();
    expect(ingestCount).toBe(1);

    await appendJsonLine(logPath, {
      event_id: "evt_sync_2",
      session_id: "ses_sync_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    await syncEventLog();
    expect(ingestCount).toBe(2);
  });

  it("returns token and turn totals for a session with no tool events", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_prompt",
      session_id: "ses_chat",
      timestamp: "2026-05-27T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "prompt.submitted",
      prompt_id: "prompt_1",
      prompt_chars: 5
    });
    await appendJsonLine(logPath, {
      event_id: "evt_resp",
      session_id: "ses_chat",
      timestamp: "2026-05-27T10:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "assistant.responded",
      message_id: "msg_1",
      model: "sonnet-test",
      stop_reason: "end_turn",
      response_chars: 5
    });
    await appendJsonLine(logPath, {
      event_id: "evt_usage",
      session_id: "ses_chat",
      timestamp: "2026-05-27T10:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "token.usage.recorded",
      message_id: "msg_1",
      model: "sonnet-test",
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1,
      server_tool_use: "{}",
      usage_source: "claude-transcript"
    });

    const app = buildApp({ dbPath, ...scopedAppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const overview = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });
    const sessions = await app.inject({ method: "GET", url: "/api/sessions?mode=calendar&range=day" });

    expect(overview.json()).toMatchObject({
      totalToolCalls: 0,
      turnCount: 1,
      responseCount: 1,
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheCreationTokens: 0,
      tokensByModel: [
        {
          model: "sonnet-test",
          totalTokens: 15,
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 1,
          cacheCreationTokens: 0
        }
      ]
    });
    expect(sessions.json()).toMatchObject({
      rows: [
        {
          sessionId: "ses_chat",
          workspacePath: "D:/projects/dev/agent-metrics",
          turnCount: 1,
          totalTokens: 15,
          lastModel: "sonnet-test"
        }
      ]
    });

    await app.close();
  });

  it("syncs known Claude transcripts before overview reads when repoRoot is provided", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-core-"));
    const paths = getAgentMetricsPaths(repoRoot);
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const transcriptDbPath = join(repoRoot, "metrics.sqlite");

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          sessionId: "ses_transcript",
          cwd: repoRoot,
          promptId: "prompt_1",
          timestamp: "2026-05-27T10:00:00.000Z",
          message: {
            role: "user",
            content: "Ship it."
          }
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "ses_transcript",
          cwd: repoRoot,
          timestamp: "2026-05-27T10:00:01.000Z",
          message: {
            id: "msg_1",
            role: "assistant",
            model: "sonnet-test",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Done." }],
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 1,
              server_tool_use: { web_search_requests: 0 }
            }
          }
        })
      ].join("\n") + "\n",
      "utf8"
    );

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_transcript"
    });

    const app = buildApp({
      dbPath: transcriptDbPath,
      eventLogPath: paths.eventLogPath,
      repoRoot,
      ...scopedAppInput
    });

    const response = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });

    expect(response.json()).toMatchObject({
      sessionCount: 1,
      totalToolCalls: 0,
      turnCount: 1,
      responseCount: 1,
      totalTokens: 15,
      tokensByModel: [
        {
          model: "sonnet-test",
          totalTokens: 15
        }
      ]
    });

    await app.close();
  });

  it("coalesces concurrent transcript sync requests across API calls", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-coalesce-"));
    let syncCount = 0;
    let releaseSync: (() => void) | null = null;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    vi.spyOn(claudeAdapter, "syncKnownClaudeTranscripts").mockImplementation(async () => {
      syncCount += 1;
      await waitForRelease;
    });

    const app = buildApp({
      dbPath,
      eventLogPath: logPath,
      repoRoot,
      ...scopedAppInput
    });

    const firstRequest = app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });
    const secondRequest = app.inject({ method: "GET", url: "/api/tools?mode=calendar&range=day" });

    await waitForCondition(() => syncCount >= 1);
    releaseSync?.();

    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);

    expect(syncCount).toBe(1);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);

    await app.close();
  });

  it("serves stale API data when transcript sync throws", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-failure-"));

    await appendJsonLine(logPath, {
      event_id: "evt_runtime_1",
      session_id: "ses_runtime_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    vi.spyOn(claudeAdapter, "syncKnownClaudeTranscripts").mockRejectedValue(
      new Error("transcript lock timeout")
    );

    const app = buildApp({
      dbPath,
      eventLogPath: logPath,
      repoRoot,
      ...scopedAppInput
    });

    const response = await app.inject({ method: "GET", url: "/api/tools?mode=calendar&range=day" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      rows: [
        {
          toolName: "Read",
          count: 1
        }
      ]
    });

    await app.close();
  });
});

describe("core api", () => {
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
      turnCount: 0,
      responseCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokensByModel: [],
      affectedFileCount: 4,
      insertions: 5,
      deletions: 3,
      sourceBreakdown: [
        {
          sourceVendor: "claude-code",
          sessionCount: 2,
          turnCount: 0,
          totalTokens: 0,
          toolCalls: 2
        }
      ],
      providerBreakdown: [],
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
      affectedFileCount: 5,
      mode: "lifetime",
      range: "week",
      windowStart: null,
      windowEnd: null
    });

    await app.close();
  });

  it("filters overview metrics by sourceVendor and returns source and provider breakdowns", async () => {
    for (const event of [
      {
        event_id: "evt_source_claude_started",
        session_id: "ses_source_claude",
        timestamp: "2026-05-27T01:00:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude-transcript",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "session.started"
      },
      {
        event_id: "evt_source_codex_started",
        session_id: "ses_source_codex",
        timestamp: "2026-05-27T02:00:00.000Z",
        source_vendor: "codex",
        source_adapter: "codex-rollout",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "session.started"
      },
      {
        event_id: "evt_source_codex_usage",
        session_id: "ses_source_codex",
        timestamp: "2026-05-27T02:00:05.000Z",
        source_vendor: "codex",
        source_adapter: "codex-rollout",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "token.usage.recorded",
        message_id: "msg_source_codex",
        model: "gpt-5-codex",
        provider_id: "ai",
        provider_base_url: "https://api.psydo.top",
        provider_host: "api.psydo.top",
        input_tokens: 100,
        output_tokens: 40,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
        server_tool_use: "{}",
        usage_source: "codex-rollout"
      }
    ]) {
      await appendJsonLine(logPath, event);
    }

    const app = buildApp({ dbPath, ...scopedAppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const allResponse = await app.inject({
      method: "GET",
      url: "/api/overview?mode=calendar&range=day&sourceVendor=all"
    });
    const codexResponse = await app.inject({
      method: "GET",
      url: "/api/overview?mode=calendar&range=day&sourceVendor=codex"
    });

    expect(allResponse.statusCode).toBe(200);
    expect(allResponse.json()).toMatchObject({
      sessionCount: 2,
      sourceBreakdown: [
        {
          sourceVendor: "claude-code",
          sessionCount: 1,
          turnCount: 0,
          totalTokens: 0,
          toolCalls: 0
        },
        {
          sourceVendor: "codex",
          sessionCount: 1,
          turnCount: 0,
          totalTokens: 150,
          toolCalls: 0
        }
      ],
      providerBreakdown: [
        {
          providerHost: "api.psydo.top",
          providerId: "ai",
          totalTokens: 150
        }
      ]
    });
    expect(codexResponse.statusCode).toBe(200);
    expect(codexResponse.json()).toMatchObject({
      sessionCount: 1,
      totalTokens: 150,
      sourceBreakdown: [
        {
          sourceVendor: "codex",
          sessionCount: 1,
          turnCount: 0,
          totalTokens: 150,
          toolCalls: 0
        }
      ],
      providerBreakdown: [
        {
          providerHost: "api.psydo.top",
          providerId: "ai",
          totalTokens: 150
        }
      ]
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
      rows: [
        {
          sessionId: "ses_today",
          workspacePath: "D:/projects/dev/agent-metrics",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          turnCount: 0,
          totalTokens: 0,
          lastModel: null
        }
      ],
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
        {
          sessionId: "ses_today",
          workspacePath: "D:/projects/dev/agent-metrics",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          turnCount: 0,
          totalTokens: 0,
          lastModel: null
        },
        {
          sessionId: "ses_week",
          workspacePath: "D:/projects/dev/agent-metrics",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          turnCount: 0,
          totalTokens: 0,
          lastModel: null
        },
        {
          sessionId: "ses_old",
          workspacePath: "D:/projects/dev/agent-metrics",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          turnCount: 0,
          totalTokens: 0,
          lastModel: null
        }
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
      event_id: "evt_detail_prompt",
      session_id: "ses_detail_1",
      timestamp: "2026-05-25T08:00:00.500Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "prompt.submitted",
      prompt_id: "prompt_1",
      prompt_chars: 19
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
      event_id: "evt_detail_assistant",
      session_id: "ses_detail_1",
      timestamp: "2026-05-25T08:00:01.500Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "assistant.responded",
      message_id: "msg_1",
      model: "gpt-5-codex",
      stop_reason: "end_turn",
      response_chars: 42
    });
    await appendJsonLine(logPath, {
      event_id: "evt_detail_usage",
      session_id: "ses_detail_1",
      timestamp: "2026-05-25T08:00:01.750Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "token.usage.recorded",
      message_id: "msg_1",
      model: null,
      input_tokens: 120,
      output_tokens: 34,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 8,
      server_tool_use: "{}",
      usage_source: "claude-transcript"
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
          createdAt: "2026-05-25T08:00:00.000Z",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "session.started",
          toolName: "",
          status: "started",
          durationMs: 0,
          promptId: null,
          promptChars: null,
          messageId: null,
          model: null,
          stopReason: null,
          responseChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        },
        {
          createdAt: "2026-05-25T08:00:00.500Z",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-transcript",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "prompt.submitted",
          toolName: "",
          status: "submitted",
          durationMs: 0,
          promptId: "prompt_1",
          promptChars: 19,
          messageId: null,
          model: null,
          stopReason: null,
          responseChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        },
        {
          createdAt: "2026-05-25T08:00:01.000Z",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "tool.succeeded",
          toolName: "Read",
          status: "succeeded",
          durationMs: 14,
          promptId: null,
          promptChars: null,
          messageId: null,
          model: null,
          stopReason: null,
          responseChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        },
        {
          createdAt: "2026-05-25T08:00:01.500Z",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-transcript",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "assistant.responded",
          toolName: "",
          status: "responded",
          durationMs: 0,
          messageId: "msg_1",
          model: "gpt-5-codex",
          stopReason: "end_turn",
          responseChars: 42,
          promptId: null,
          promptChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        },
        {
          createdAt: "2026-05-25T08:00:01.750Z",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-transcript",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "token.usage.recorded",
          toolName: "",
          status: "recorded",
          durationMs: 0,
          messageId: "msg_1",
          model: "unknown",
          inputTokens: 120,
          outputTokens: 34,
          cacheReadTokens: 8,
          cacheCreationTokens: 12,
          totalTokens: 174,
          usageSource: "claude-transcript",
          promptId: null,
          promptChars: null,
          stopReason: null,
          responseChars: null
        },
        {
          createdAt: "2026-05-25T08:00:02.000Z",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          filesChanged: ["src/app.ts"],
          insertions: 3,
          deletions: 1,
          type: "code.edit.applied",
          toolName: "Edit",
          status: "applied",
          durationMs: 0,
          promptId: null,
          promptChars: null,
          messageId: null,
          model: null,
          stopReason: null,
          responseChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        },
        {
          createdAt: "2026-05-25T08:00:03.000Z",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-hook",
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          type: "session.ended",
          toolName: "",
          status: "ended",
          durationMs: 0,
          promptId: null,
          promptChars: null,
          messageId: null,
          model: null,
          stopReason: null,
          responseChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        }
      ]
    });

    await app.close();
  });

  it("aggregates overview tokens by model with an unknown fallback sorted by total tokens", async () => {
    for (const event of [
      {
        event_id: "evt_model_started",
        session_id: "ses_model",
        timestamp: "2026-05-27T10:00:00.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "session.started"
      },
      {
        event_id: "evt_model_a",
        session_id: "ses_model",
        timestamp: "2026-05-27T10:00:01.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "token.usage.recorded",
        message_id: "msg_model_a",
        model: "sonnet-test",
        input_tokens: 20,
        output_tokens: 6,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 1,
        server_tool_use: "{}",
        usage_source: "claude-transcript"
      },
      {
        event_id: "evt_model_b",
        session_id: "ses_model",
        timestamp: "2026-05-27T10:00:02.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "token.usage.recorded",
        message_id: "msg_model_b",
        model: null,
        input_tokens: 5,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: "{}",
        usage_source: "claude-transcript"
      },
      {
        event_id: "evt_model_c",
        session_id: "ses_model",
        timestamp: "2026-05-27T10:00:03.000Z",
        source_vendor: "claude-code",
        source_adapter: "claude",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "token.usage.recorded",
        message_id: "msg_model_c",
        model: "haiku-test",
        input_tokens: 4,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: "{}",
        usage_source: "claude-transcript"
      }
    ]) {
      await appendJsonLine(logPath, event);
    }

    const app = buildApp({ dbPath, ...scopedAppInput });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tokensByModel: [
        {
          model: "sonnet-test",
          totalTokens: 30,
          inputTokens: 20,
          outputTokens: 6,
          cacheReadTokens: 1,
          cacheCreationTokens: 3
        },
        {
          model: "unknown",
          totalTokens: 7,
          inputTokens: 5,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        },
        {
          model: "haiku-test",
          totalTokens: 5,
          inputTokens: 4,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await delay(10);
  }

  throw new Error("Condition not met before timeout.");
}
