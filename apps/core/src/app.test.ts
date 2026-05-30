import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as claudeAdapter from "@agent-metrics/adapters-claude";
import * as codexAdapter from "@agent-metrics/adapters-codex";
import * as opencodeAdapter from "@agent-metrics/adapters-opencode";
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
  delete process.env.AGENT_METRICS_OPENCODE_DB_PATH;
  delete process.env.AGENT_METRICS_OPENCODE_MODELS_PATH;
  delete process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT;
  delete process.env.AGENT_METRICS_CODEX_LOGS_DB_PATH;
  delete process.env.AGENT_METRICS_CODEX_CONFIG_PATH;
  const root = await mkdtemp(join(tmpdir(), "agent-metrics-core-"));
  process.env.AGENT_METRICS_OPENCODE_DB_PATH = join(root, "missing-opencode.db");
  process.env.AGENT_METRICS_OPENCODE_MODELS_PATH = join(root, "missing-models.json");
  process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT = join(root, "missing-codex-sessions");
  process.env.AGENT_METRICS_CODEX_LOGS_DB_PATH = join(root, "missing-logs_2.sqlite");
  process.env.AGENT_METRICS_CODEX_CONFIG_PATH = join(root, "missing-config.toml");
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

  it("persists the event-log cursor and advances it across app restarts", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_cursor_1",
      session_id: "ses_cursor_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    const firstSize = (await stat(logPath)).size;
    const app = buildApp({ dbPath, ...may25AppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    expect(
      app.db
        .prepare<{ offsetBytes: number; sizeBytes: number }>(
          "SELECT offset_bytes AS offsetBytes, size_bytes AS sizeBytes FROM ingestion_state WHERE stream_name = 'events.jsonl'"
        )
        .get()
    ).toMatchObject({
      offsetBytes: firstSize,
      sizeBytes: firstSize
    });

    await app.close();

    await appendJsonLine(logPath, {
      event_id: "evt_cursor_2",
      session_id: "ses_cursor_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    const secondSize = (await stat(logPath)).size;
    const restartedApp = buildApp({ dbPath, ...may25AppInput });
    await ingestEventLog({ app: restartedApp, eventLogPath: logPath });

    expect(
      restartedApp
        .db
        .prepare<{ offsetBytes: number; sizeBytes: number }>(
          "SELECT offset_bytes AS offsetBytes, size_bytes AS sizeBytes FROM ingestion_state WHERE stream_name = 'events.jsonl'"
        )
        .get()
    ).toMatchObject({
      offsetBytes: secondSize,
      sizeBytes: secondSize
    });

    const response = await restartedApp.inject({ method: "GET", url: "/api/overview" });
    expect(response.json()).toMatchObject({
      sessionCount: 1,
      totalToolCalls: 1,
      successfulExecutions: 1
    });

    await restartedApp.close();
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

  it("syncs OpenCode database state before overview reads when repoRoot is provided", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-core-"));
    const paths = getAgentMetricsPaths(repoRoot);
    const fixture = await createOpenCodeFixture(repoRoot);
    process.env.AGENT_METRICS_OPENCODE_DB_PATH = fixture.dbPath;
    process.env.AGENT_METRICS_OPENCODE_MODELS_PATH = fixture.modelsPath;

    const app = buildApp({
      dbPath,
      eventLogPath: paths.eventLogPath,
      repoRoot,
      ...scopedAppInput
    });

    const overview = await app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });
    const sessions = await app.inject({ method: "GET", url: "/api/sessions?mode=calendar&range=day" });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      sessionCount: 1,
      totalToolCalls: 1,
      successfulExecutions: 1,
      failedExecutions: 0,
      turnCount: 1,
      responseCount: 1,
      totalTokens: 29725,
      inputTokens: 27470,
      outputTokens: 207,
      cacheReadTokens: 2048,
      cacheCreationTokens: 0,
      sourceBreakdown: [
        {
          sourceVendor: "opencode",
          sessionCount: 1,
          turnCount: 1,
          totalTokens: 29725,
          toolCalls: 1
        }
      ],
      providerBreakdown: [
        {
          providerId: "opencode",
          providerHost: "opencode.ai",
          totalTokens: 29725
        }
      ],
      tokensByModel: [
        {
          model: "hy3-preview-free",
          totalTokens: 29725
        }
      ]
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toMatchObject({
      rows: [
        {
          sessionId: "ses_open_1",
          sourceVendor: "opencode",
          sourceAdapter: "opencode-db",
          providerId: "opencode",
          providerHost: "opencode.ai",
          totalTokens: 29725,
          lastModel: "hy3-preview-free"
        }
      ]
    });

    await app.close();
  });

  it("serves stale API data when OpenCode sync throws", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-failure-"));

    await appendJsonLine(logPath, {
      event_id: "evt_runtime_open_1",
      session_id: "ses_runtime_open_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    vi.spyOn(opencodeAdapter, "syncOpenCodeDatabase").mockRejectedValue(
      new Error("opencode database busy")
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

  it("syncs Codex rollout state before overview reads when repoRoot is provided", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-codex-core-"));
    const paths = getAgentMetricsPaths(repoRoot);
    const fixture = await createCodexFixture(repoRoot);
    process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT = fixture.sessionsRoot;
    process.env.AGENT_METRICS_CODEX_LOGS_DB_PATH = fixture.logsDbPath;
    process.env.AGENT_METRICS_CODEX_CONFIG_PATH = fixture.configPath;

    const app = buildApp({
      dbPath,
      eventLogPath: paths.eventLogPath,
      repoRoot,
      ...scopedAppInput
    });

    const overview = await app.inject({
      method: "GET",
      url: "/api/overview?mode=calendar&range=day&sourceVendor=codex"
    });
    const sessions = await app.inject({
      method: "GET",
      url: "/api/sessions?mode=calendar&range=day&sourceVendor=codex"
    });
    const tools = await app.inject({
      method: "GET",
      url: "/api/tools?mode=calendar&range=day&sourceVendor=codex"
    });
    const session = await app.inject({
      method: "GET",
      url: "/api/sessions/019e5dc9-b10c-7371-8edd-066e8db7e50d"
    });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      sessionCount: 1,
      turnCount: 1,
      responseCount: 1,
      totalTokens: 19623,
      inputTokens: 15928,
      outputTokens: 239,
      cacheReadTokens: 3456,
      cacheCreationTokens: 0,
      totalToolCalls: 4,
      successfulExecutions: 4,
      failedExecutions: 0,
      editOperationCount: 1,
      affectedFileCount: 1,
      sourceBreakdown: [
        {
          sourceVendor: "codex",
          sessionCount: 1,
          turnCount: 1,
          totalTokens: 19623,
          toolCalls: 4
        }
      ],
      providerBreakdown: [
        {
          providerHost: "api.psydo.top",
          providerId: "ai",
          totalTokens: 19623
        }
      ],
      tokensByModel: [
        {
          model: "gpt-5.4",
          totalTokens: 19623
        }
      ]
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toMatchObject({
      rows: [
        {
          sessionId: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
          sourceVendor: "codex",
          sourceAdapter: "codex-rollout",
          providerId: "ai",
          providerHost: "api.psydo.top",
          turnCount: 1,
          totalTokens: 19623,
          lastModel: "gpt-5.4"
        }
      ]
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          toolName: "Edit",
          count: 1
        }),
        expect.objectContaining({
          toolName: "Search",
          count: 1
        }),
        expect.objectContaining({
          toolName: "WebSearch",
          count: 1
        }),
        expect.objectContaining({
          toolName: "Shell",
          count: 1
        })
      ])
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      timeline: expect.arrayContaining([
        expect.objectContaining({
          type: "prompt.submitted",
          sourceVendor: "codex"
        }),
        expect.objectContaining({
          type: "assistant.responded",
          sourceVendor: "codex",
          providerHost: "api.psydo.top",
          model: "gpt-5.4"
        }),
        expect.objectContaining({
          type: "tool.succeeded",
          sourceVendor: "codex",
          toolName: "rg",
          durationMs: 2300
        }),
        expect.objectContaining({
          type: "tool.succeeded",
          sourceVendor: "codex",
          toolName: "apply_patch"
        }),
        expect.objectContaining({
          type: "tool.succeeded",
          sourceVendor: "codex",
          toolName: "WebSearch"
        }),
        expect.objectContaining({
          type: "tool.succeeded",
          sourceVendor: "codex",
          toolName: "PowerShell",
          durationMs: 2285
        }),
        expect.objectContaining({
          type: "code.edit.applied",
          sourceVendor: "codex",
          toolName: "apply_patch"
        })
      ])
    });

    await app.close();
  });

  it("serves stale API data when Codex sync throws", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-codex-failure-"));

    await appendJsonLine(logPath, {
      event_id: "evt_runtime_codex_1",
      session_id: "ses_runtime_codex_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    vi.spyOn(codexAdapter, "syncCodexRollouts").mockRejectedValue(
      new Error("codex rollout locked")
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

  it("groups Codex tool rankings into broader dashboard categories", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_0",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_1",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "get-content",
      status: "succeeded",
      duration_ms: 10
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_2",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:02.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.failed",
      tool_name: "get-content",
      status: "failed",
      duration_ms: 30
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_3",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:03.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "get-childitem",
      status: "succeeded",
      duration_ms: 50
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_4",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:04.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "invoke-restmethod",
      status: "succeeded",
      duration_ms: 70
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_4b",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:04.500Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "(invoke-webrequest",
      status: "succeeded",
      duration_ms: 60
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_4c",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:04.700Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "update_plan",
      status: "succeeded",
      duration_ms: 0
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_4d",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:04.800Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "$json",
      status: "succeeded",
      duration_ms: 0
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_5",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:05.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "PowerShell",
      status: "succeeded",
      duration_ms: 40
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_6",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:06.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "rg",
      status: "succeeded",
      duration_ms: 20
    });

    await appendJsonLine(logPath, {
      event_id: "evt_codex_rank_7",
      session_id: "ses_codex_rank_1",
      timestamp: "2026-05-25T08:00:07.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "apply_patch",
      status: "succeeded",
      duration_ms: 0
    });

    const app = buildApp({ dbPath, ...may25AppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const response = await app.inject({
      method: "GET",
      url: "/api/tools?mode=calendar&range=day&sourceVendor=codex"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rows: [
        { toolName: "HTTP", count: 2, failures: 0, averageDurationMs: 65 },
        { toolName: "Read", count: 2, failures: 1, averageDurationMs: 20 },
        { toolName: "Edit", count: 1, failures: 0, averageDurationMs: 0 },
        { toolName: "List", count: 1, failures: 0, averageDurationMs: 50 },
        { toolName: "Search", count: 1, failures: 0, averageDurationMs: 20 },
        { toolName: "Shell", count: 1, failures: 0, averageDurationMs: 40 }
      ],
      mode: "calendar",
      range: "day",
      timezone: "UTC",
      windowStart: "2026-05-25T00:00:00.000Z",
      windowEnd: "2026-05-25T09:00:00.000Z",
      updatedAt: "2026-05-25T09:00:00.000Z"
    });

    await app.close();
  });

  it("groups Codex macOS and Windows file-reading commands under Read", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_codex_read_1",
      session_id: "ses_codex_read_1",
      timestamp: "2026-05-25T08:10:00.000Z",
      source_vendor: "codex",
      source_adapter: "codex-rollout",
      workspace_path: "/Users/test/dev/agent-metrics",
      type: "session.started"
    });

    for (const [index, toolName] of ["sed", "get-content", "head", "tail", "nl"].entries()) {
      await appendJsonLine(logPath, {
        event_id: `evt_codex_read_tool_${index + 1}`,
        session_id: "ses_codex_read_1",
        timestamp: `2026-05-25T08:10:0${index + 1}.000Z`,
        source_vendor: "codex",
        source_adapter: "codex-rollout",
        workspace_path: "/Users/test/dev/agent-metrics",
        type: "tool.succeeded",
        tool_name: toolName,
        status: "succeeded",
        duration_ms: 10
      });
    }

    const app = buildApp({ dbPath, ...may25AppInput });
    await ingestEventLog({ app, eventLogPath: logPath });

    const response = await app.inject({
      method: "GET",
      url: "/api/tools?mode=calendar&range=day&sourceVendor=codex"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      rows: [{ toolName: "Read", count: 5, failures: 0, averageDurationMs: 10 }],
      mode: "calendar",
      range: "day",
      timezone: "UTC",
      windowStart: "2026-05-25T00:00:00.000Z",
      windowEnd: "2026-05-25T09:00:00.000Z",
      updatedAt: "2026-05-25T09:00:00.000Z"
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

async function createOpenCodeFixtureDb(root: string): Promise<string> {
  const opencodeDbPath = join(root, "opencode.db");
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const db = new BetterSqlite3(opencodeDbPath);

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  db.prepare(`
    INSERT INTO session (
      id, project_id, parent_id, slug, directory, title, version, share_url,
      summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
      time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model,
      cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0)
  `).run(
    "ses_open_1",
    "proj_1",
    "slug-1",
    root,
    "Demo",
    "1",
    1779875940000,
    1779876003000
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_user_1",
    "ses_open_1",
    1779876000355,
    1779876000355,
    JSON.stringify({
      role: "user",
      time: { created: 1779876000355 }
    })
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    "msg_assistant_1",
    "ses_open_1",
    1779876001153,
    1779876002420,
    JSON.stringify({
      role: "assistant",
      time: {
        created: 1779876001153,
        completed: 1779876002420
      },
      providerID: "opencode",
      modelID: "hy3-preview-free",
      finish: "tool-calls",
      path: {
        root
      },
      tokens: {
        input: 27470,
        output: 207,
        reasoning: 0,
        cache: {
          read: 2048,
          write: 0
        }
      }
    })
  );
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "prt_user_text",
    "msg_user_1",
    "ses_open_1",
    1779876000355,
    1779876000355,
    JSON.stringify({
      type: "text",
      text: "PopupActivity这个文件能看到里面是什么吗？"
    })
  );
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "prt_assistant_text",
    "msg_assistant_1",
    "ses_open_1",
    1779876001641,
    1779876001641,
    JSON.stringify({
      type: "text",
      text: "找到了！"
    })
  );
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "prt_tool_1",
    "msg_assistant_1",
    "ses_open_1",
    1779876002227,
    1779876002866,
    JSON.stringify({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: {
          filePath: join(root, "src", "app.ts")
        },
        time: {
          start: 1779876002852,
          end: 1779876002866
        }
      }
    })
  );

  db.close();
  return opencodeDbPath;
}

async function createOpenCodeFixture(root: string): Promise<{
  dbPath: string;
  modelsPath: string;
}> {
  const dbPath = await createOpenCodeFixtureDb(root);
  const modelsPath = join(root, "models.json");

  await writeFile(
    modelsPath,
    JSON.stringify(
      {
        opencode: {
          id: "opencode",
          api: "https://opencode.ai/zen/v1"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    dbPath,
    modelsPath
  };
}

async function createCodexFixture(root: string): Promise<{
  sessionsRoot: string;
  logsDbPath: string;
  configPath: string;
}> {
  const sessionsRoot = join(root, "codex-sessions");
  const dayRoot = join(sessionsRoot, "2026", "05", "27");
  const rolloutPath = join(
    dayRoot,
    "rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl"
  );
  const logsDbPath = join(root, "logs_2.sqlite");
  const configPath = join(root, "config.toml");

  await mkdir(dayRoot, { recursive: true });
  await writeFile(
    configPath,
    [
      'model_provider = "ai"',
      "",
      "[model_providers.ai]",
      'base_url = "https://api.psydo.top"'
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-05-27T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
          timestamp: "2026-05-27T10:00:00.000Z",
          cwd: root,
          model_provider: "ai"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Review the telemetry changes."
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Reading the diff now.",
          phase: "commentary"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:02.500Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call_shell_fn_1",
          name: "shell_command",
          arguments: JSON.stringify({
            command: "rg -n \"patch_apply_end\" D:/projects/dev/agent-metrics -S",
            workdir: root,
            timeout_ms: 10000
          })
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:02.800Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_shell_fn_1",
          output: [
            "Exit code: 0",
            "Wall time: 2.3 seconds",
            "Output:",
            "D:/projects/dev/agent-metrics/src/app.ts:1:..."
          ].join("\n")
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call_patch_1",
          success: true,
          stdout: "Success. Updated the following files:\nM src/app.ts\n",
          stderr: "",
          changes: {
            [join(root, "src", "app.ts")]: {
              type: "update",
              unified_diff:
                "@@ -1,2 +1,3 @@\n import x\n+const y = 1;\n-old\n+new\n"
            }
          }
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "web_search_end",
          call_id: "call_web_1",
          query: "codex rollout patch_apply_end",
          action: {
            type: "search"
          }
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "call_shell_1",
          command: [
            "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            "-Command",
            "git diff --stat"
          ],
          cwd: root,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration: {
            secs: 2,
            nanos: 284934500
          },
          status: "completed"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-27T10:00:12.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 29619,
              cached_input_tokens: 6912,
              output_tokens: 702,
              reasoning_output_tokens: 333,
              total_tokens: 30321
            },
            last_token_usage: {
              input_tokens: 15928,
              cached_input_tokens: 3456,
              output_tokens: 202,
              reasoning_output_tokens: 37,
              total_tokens: 16130
            }
          }
        }
      })
    ].join("\n"),
    "utf8"
  );

  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const db = new BetterSqlite3(logsDbPath);
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL DEFAULT 0,
      level TEXT NOT NULL DEFAULT 'INFO',
      target TEXT NOT NULL DEFAULT 'codex_otel.log_only',
      feedback_log_body TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes) VALUES (?, 0, 'INFO', 'codex_otel.log_only', ?, 0)"
  ).run(
    1779876012,
    'event.name="codex.sse_event" conversation.id=019e5dc9-b10c-7371-8edd-066e8db7e50d model=gpt-5.4 slug=gpt-5.4'
  );
  db.close();

  return {
    sessionsRoot,
    logsDbPath,
    configPath
  };
}
