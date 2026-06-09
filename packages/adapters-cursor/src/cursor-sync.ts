import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { AnyEvent } from "@agent-metrics/event-schema";
import { appendJsonLine } from "@agent-metrics/shared-utils";

type CursorState = {
  conversationUpdatedAt: number;
  composerUpdatedAt: number;
  promptUpdatedAt: number;
  generationUpdatedAt: number;
};

type EventLedger = {
  eventIds: string[];
};

type ReadOnlyDatabase = {
  close(): void;
  prepare<Result = unknown>(sql: string): {
    all(...params: unknown[]): Result[];
    get(...params: unknown[]): Result | undefined;
  };
};

type ConversationSummaryRow = {
  conversationId: string;
  title: string | null;
  tldr: string | null;
  overview: string | null;
  summaryBullets: string | null;
  model: string | null;
  mode: string | null;
  updatedAt: number;
};

type CursorSession = {
  sessionId: string;
  workspacePath: string;
  createdAt: number | null;
  updatedAt: number | null;
  model: string | null;
  editSummary: {
    filesChanged: string[];
    fileCount: number;
    insertions: number;
    deletions: number;
  } | null;
};

type CursorPrompt = {
  eventId: string;
  sessionId: string;
  workspacePath: string;
  promptId: string;
  promptChars: number;
  timestamp: string;
};

type CursorGeneration = {
  sessionId: string;
  workspacePath: string;
  messageId: string;
  timestamp: string;
  model: string | null;
  responseChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  usageSource: "cursor-generation" | "cursor-composer-context" | null;
};

type CursorHashRequest = {
  sessionId: string;
  workspacePath: string;
  requestId: string;
  model: string | null;
  startedAt: number;
  completedAt: number;
  filesChanged: string[];
};

type CursorHashRequestRow = {
  conversationId: string | null;
  requestId: string | null;
  model: string | null;
  minCreatedAt: number | null;
  maxCreatedAt: number | null;
  fileNames: string | null;
};

type CursorTranscriptExtraction = {
  prompts: CursorPrompt[];
  generations: CursorGeneration[];
};

type CursorComposerUsageFallback = {
  sessionId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

const CURSOR_SOURCE_VENDOR = "cursor" as const;
const CURSOR_SOURCE_ADAPTER = "cursor-ide" as const;

export function resolveDefaultCursorTrackingDbPath(): string {
  return join(homedir(), ".cursor", "ai-tracking", "ai-code-tracking.db");
}

export function resolveDefaultCursorWorkspaceStorageRoot(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User", "workspaceStorage");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage");
  }

  return join(homedir(), ".config", "Cursor", "User", "workspaceStorage");
}

export function resolveDefaultCursorStorageJsonPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage", "storage.json");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "storage.json");
  }

  return join(homedir(), ".config", "Cursor", "User", "globalStorage", "storage.json");
}

export function resolveDefaultCursorGlobalStorageDbPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }

  return join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

export function resolveDefaultCursorProjectsRoot(): string {
  return join(homedir(), ".cursor", "projects");
}

function resolveCursorGlobalStorageDbPath(storageJsonPath: string): string {
  return join(dirname(storageJsonPath), "state.vscdb");
}

export async function syncCursorArtifacts(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  trackingDbPath?: string;
  workspaceStorageRoot?: string;
  storageJsonPath?: string;
  globalStorageDbPath?: string;
  cursorProjectsRoot?: string;
}): Promise<void> {
  const trackingDbPath =
    input.trackingDbPath ??
    process.env.AGENT_METRICS_CURSOR_TRACKING_DB_PATH ??
    resolveDefaultCursorTrackingDbPath();
  const workspaceStorageRoot =
    input.workspaceStorageRoot ??
    process.env.AGENT_METRICS_CURSOR_WORKSPACE_STORAGE_ROOT ??
    resolveDefaultCursorWorkspaceStorageRoot();
  const storageJsonPath =
    input.storageJsonPath ??
    process.env.AGENT_METRICS_CURSOR_STORAGE_JSON_PATH ??
    resolveDefaultCursorStorageJsonPath();
  const globalStorageDbPath =
    input.globalStorageDbPath ??
    process.env.AGENT_METRICS_CURSOR_GLOBAL_STORAGE_DB_PATH ??
    resolveCursorGlobalStorageDbPath(storageJsonPath);
  const cursorProjectsRoot =
    input.cursorProjectsRoot ??
    process.env.AGENT_METRICS_CURSOR_PROJECTS_ROOT ??
    resolveDefaultCursorProjectsRoot();

  if (
    !existsSync(trackingDbPath) &&
    !existsSync(workspaceStorageRoot) &&
    !existsSync(globalStorageDbPath) &&
    !existsSync(cursorProjectsRoot)
  ) {
    return;
  }

  const state = await loadState(input.cursorPath);
  const ledger = await loadLedger(input.ledgerPath);
  const seenEventIds = await loadEventIdsFromEventLog(input.eventLogPath, "cursor:");

  for (const eventId of ledger.eventIds) {
    seenEventIds.add(eventId);
  }

  const workspaceLookup = await loadWorkspaceLookup(storageJsonPath);
  const sessions = new Map<string, CursorSession>();
  const prompts: CursorPrompt[] = [];
  const generations: CursorGeneration[] = [];
  const hashRequests: CursorHashRequest[] = [];
  const composerUsageFallbacks = new Map<string, CursorComposerUsageFallback>();

  if (existsSync(trackingDbPath)) {
    const trackingDb = new Database(trackingDbPath, { readonly: true, fileMustExist: true }) as ReadOnlyDatabase;
    try {
      const rows = trackingDb
        .prepare<ConversationSummaryRow>(
          `SELECT conversationId, title, tldr, overview, summaryBullets, model, mode, updatedAt
           FROM conversation_summaries
           WHERE updatedAt >= ?
           ORDER BY updatedAt ASC, conversationId ASC`
        )
        .all(state.conversationUpdatedAt);

      for (const row of rows) {
        const session = ensureSession(sessions, row.conversationId, "Cursor");
        session.updatedAt = maxNullableNumber(session.updatedAt, row.updatedAt);
        session.model = row.model ?? session.model;
      }

      if (hasTable(trackingDb, "ai_code_hashes")) {
        const hashRows = trackingDb
          .prepare<CursorHashRequestRow>(
            `SELECT
               conversationId,
               requestId,
               model,
               MIN(createdAt) AS minCreatedAt,
               MAX(createdAt) AS maxCreatedAt,
               GROUP_CONCAT(DISTINCT fileName) AS fileNames
             FROM ai_code_hashes
             WHERE createdAt >= ?
               AND conversationId IS NOT NULL
               AND requestId IS NOT NULL
             GROUP BY conversationId, requestId, model
             ORDER BY maxCreatedAt ASC, conversationId ASC, requestId ASC`
          )
          .all(state.conversationUpdatedAt);

        for (const row of hashRows) {
          const sessionId = normalizeOptionalString(row.conversationId);
          const requestId = normalizeOptionalString(row.requestId);
          const startedAt = normalizeTimestampMs(row.minCreatedAt);
          const completedAt = normalizeTimestampMs(row.maxCreatedAt);

          if (!sessionId || !requestId || startedAt === null || completedAt === null) {
            continue;
          }

          const filesChanged = parseCursorHashFiles(row.fileNames);
          const workspacePath = inferWorkspacePathFromFiles(filesChanged) ?? "Cursor";
          const session = ensureSession(sessions, sessionId, workspacePath);
          session.createdAt = minNullableNumber(session.createdAt, startedAt);
          session.updatedAt = maxNullableNumber(session.updatedAt, completedAt);
          session.model = normalizeOptionalString(row.model) ?? session.model;

          hashRequests.push({
            sessionId,
            workspacePath,
            requestId,
            model: normalizeOptionalString(row.model),
            startedAt,
            completedAt,
            filesChanged
          });
        }
      }
    } finally {
      trackingDb.close();
    }
  }

  if (existsSync(workspaceStorageRoot)) {
    for (const workspaceDbPath of await collectWorkspaceStorageDatabases(workspaceStorageRoot)) {
      const workspaceId = dirname(workspaceDbPath).split(/[/\\]/u).pop() ?? "";
      const workspacePath = workspaceLookup.get(workspaceId) ?? "Cursor";
      const db = new Database(workspaceDbPath, { readonly: true, fileMustExist: true }) as ReadOnlyDatabase;

      try {
        const rows = db
          .prepare<{ key: string; value: string | null }>(
            `SELECT key, value
             FROM ItemTable
             WHERE key IN ('composer.composerData', 'aiService.prompts', 'aiService.generations')`
          )
          .all();
        const values = new Map(rows.map((row) => [row.key, row.value] as const));

        const composerData = parseJson(values.get("composer.composerData"));
        for (const composer of extractComposers(composerData)) {
          const session = ensureSession(sessions, composer.sessionId, workspacePath);
          session.createdAt = minNullableNumber(session.createdAt, composer.createdAt);
          session.updatedAt = maxNullableNumber(session.updatedAt, composer.createdAt);
          session.model = session.model;
          if (composer.editSummary) {
            session.editSummary = composer.editSummary;
          }
        }

        const promptData = parseJson(values.get("aiService.prompts"));
        for (const prompt of extractPrompts(promptData, workspacePath)) {
          prompts.push(prompt);
          const session = ensureSession(sessions, prompt.sessionId, workspacePath);
          session.createdAt = minNullableNumber(session.createdAt, parseIsoTimestamp(prompt.timestamp));
          session.updatedAt = maxNullableNumber(session.updatedAt, parseIsoTimestamp(prompt.timestamp));
        }

        const generationData = parseJson(values.get("aiService.generations"));
        for (const generation of extractGenerations(generationData, workspacePath)) {
          generations.push(generation);
          const session = ensureSession(sessions, generation.sessionId, workspacePath);
          session.updatedAt = maxNullableNumber(session.updatedAt, parseIsoTimestamp(generation.timestamp));
          session.model = generation.model ?? session.model;
        }
      } finally {
        db.close();
      }
    }
  }

  if (existsSync(globalStorageDbPath)) {
    const globalDb = new Database(globalStorageDbPath, { readonly: true, fileMustExist: true }) as ReadOnlyDatabase;

    try {
      const rows = globalDb
        .prepare<{ key: string; value: string | null }>(
          `SELECT key, value
           FROM ItemTable
           WHERE key IN ('composer.composerHeaders')`
        )
        .all();
      const values = new Map(rows.map((row) => [row.key, row.value] as const));
      const composerHeaders = parseJson(values.get("composer.composerHeaders"));

      for (const composer of extractComposers(composerHeaders)) {
        const workspacePath =
          composer.workspacePath ?? workspaceLookup.get(composer.workspaceId ?? "") ?? "Cursor";
        const session = ensureSession(sessions, composer.sessionId, workspacePath);
        session.createdAt = minNullableNumber(session.createdAt, composer.createdAt);
        session.updatedAt = maxNullableNumber(session.updatedAt, composer.updatedAt ?? composer.createdAt);
        if (composer.editSummary) {
          session.editSummary = composer.editSummary;
        }
      }

      if (hasTable(globalDb, "cursorDiskKV")) {
        const extractedFallbacks = extractComposerUsageFallbacks(
          globalDb
            .prepare<{ key: string; value: unknown }>(
              `SELECT key, value
               FROM cursorDiskKV
               WHERE key LIKE 'composerData:%'`
            )
            .all()
        );
        for (const [sessionId, fallback] of extractedFallbacks) {
          composerUsageFallbacks.set(sessionId, fallback);
        }
      }
    } finally {
      globalDb.close();
    }
  }

  if (existsSync(cursorProjectsRoot)) {
    const transcriptSessionIds = new Set(
      Array.from(sessions.keys()).filter(
        (sessionId) =>
          !prompts.some((prompt) => prompt.sessionId === sessionId) ||
          !generations.some((generation) => generation.sessionId === sessionId)
      )
    );
    const transcriptExtraction = await extractCursorTranscripts(cursorProjectsRoot, sessions, transcriptSessionIds);
    prompts.push(...transcriptExtraction.prompts);
    generations.push(...transcriptExtraction.generations);
  }

  applyComposerUsageFallbacks(generations, sessions, composerUsageFallbacks);

  const events = buildCursorEvents({
    sessions,
    prompts,
    generations,
    hashRequests
  }).sort(compareCursorEvents);

  let ledgerChanged = false;

  for (const event of events) {
    if (seenEventIds.has(event.event_id)) {
      continue;
    }

    await appendJsonLine(input.eventLogPath, event);
    seenEventIds.add(event.event_id);
    ledgerChanged = true;
  }

  if (ledgerChanged) {
    await writeJsonFileAtomic(input.ledgerPath, {
      eventIds: [...seenEventIds].sort()
    } satisfies EventLedger);
  }

  await writeJsonFileAtomic(input.cursorPath, {
    conversationUpdatedAt: maxCursorValue(
      state.conversationUpdatedAt,
      Array.from(sessions.values()).flatMap((session) => (session.updatedAt === null ? [] : [session.updatedAt]))
    ),
    composerUpdatedAt: maxCursorValue(
      state.composerUpdatedAt,
      Array.from(sessions.values()).flatMap((session) => (session.createdAt === null ? [] : [session.createdAt]))
    ),
    promptUpdatedAt: maxCursorValue(
      state.promptUpdatedAt,
      prompts.map((prompt) => parseIsoTimestamp(prompt.timestamp))
    ),
    generationUpdatedAt: maxCursorValue(
      state.generationUpdatedAt,
      generations.map((generation) => parseIsoTimestamp(generation.timestamp))
    )
  } satisfies CursorState);
}

function buildCursorEvents(input: {
  sessions: Map<string, CursorSession>;
  prompts: CursorPrompt[];
  generations: CursorGeneration[];
  hashRequests: CursorHashRequest[];
}): AnyEvent[] {
  const events: AnyEvent[] = [];

  for (const session of input.sessions.values()) {
    if (session.createdAt !== null) {
      events.push({
        event_id: `cursor:session:${session.sessionId}:started`,
        session_id: session.sessionId,
        timestamp: toIsoTimestamp(session.createdAt),
        source_vendor: CURSOR_SOURCE_VENDOR,
        source_adapter: CURSOR_SOURCE_ADAPTER,
        workspace_path: session.workspacePath,
        type: "session.started"
      });
    }

    if (
      session.editSummary &&
      (session.editSummary.fileCount > 0 ||
        session.editSummary.insertions > 0 ||
        session.editSummary.deletions > 0) &&
      session.createdAt !== null
    ) {
      const editTimestamp = session.updatedAt ?? session.createdAt;
      events.push({
        event_id: `cursor:edit:${session.sessionId}:${session.createdAt}`,
        session_id: session.sessionId,
        timestamp: toIsoTimestamp(editTimestamp),
        source_vendor: CURSOR_SOURCE_VENDOR,
        source_adapter: CURSOR_SOURCE_ADAPTER,
        workspace_path: session.workspacePath,
        type: "code.edit.applied",
        tool_name: "Composer",
        files_changed: session.editSummary.filesChanged,
        file_count: session.editSummary.fileCount,
        insertions: session.editSummary.insertions,
        deletions: session.editSummary.deletions,
        edit_operation_count: 1
      });
    }
  }

  for (const prompt of input.prompts) {
    events.push({
      event_id: prompt.eventId,
      session_id: prompt.sessionId,
      timestamp: prompt.timestamp,
      source_vendor: CURSOR_SOURCE_VENDOR,
      source_adapter: CURSOR_SOURCE_ADAPTER,
      workspace_path: prompt.workspacePath,
      type: "prompt.submitted",
      prompt_id: prompt.promptId,
      prompt_chars: prompt.promptChars
    });
  }

  for (const generation of input.generations) {
    if (generation.responseChars > 0) {
      events.push({
        event_id: `cursor:assistant:${generation.messageId}`,
        session_id: generation.sessionId,
        timestamp: generation.timestamp,
        source_vendor: CURSOR_SOURCE_VENDOR,
        source_adapter: CURSOR_SOURCE_ADAPTER,
        workspace_path: generation.workspacePath,
        type: "assistant.responded",
        message_id: generation.messageId,
        model: generation.model,
        stop_reason: "end_turn",
        response_chars: generation.responseChars
      });
    }

    if (
      generation.inputTokens !== null &&
      generation.outputTokens !== null &&
      generation.cacheReadInputTokens !== null &&
      generation.cacheCreationInputTokens !== null
    ) {
      events.push({
        event_id: `cursor:usage:${generation.messageId}`,
        session_id: generation.sessionId,
        timestamp: generation.timestamp,
        source_vendor: CURSOR_SOURCE_VENDOR,
        source_adapter: CURSOR_SOURCE_ADAPTER,
        workspace_path: generation.workspacePath,
        type: "token.usage.recorded",
        message_id: generation.messageId,
        model: generation.model,
        input_tokens: generation.inputTokens,
        output_tokens: generation.outputTokens,
        cache_creation_input_tokens: generation.cacheCreationInputTokens,
        cache_read_input_tokens: generation.cacheReadInputTokens,
        server_tool_use: "{}",
        usage_source: generation.usageSource ?? "cursor-generation",
        provider_id: null,
        provider_base_url: null,
        provider_host: null
      });
    }
  }

  for (const request of input.hashRequests) {
    events.push({
      event_id: `cursor:tool:${request.sessionId}:${request.requestId}:started`,
      session_id: request.sessionId,
      timestamp: toIsoTimestamp(request.startedAt),
      source_vendor: CURSOR_SOURCE_VENDOR,
      source_adapter: CURSOR_SOURCE_ADAPTER,
      workspace_path: request.workspacePath,
      type: "tool.called",
      tool_name: "Composer",
      status: "started",
      argument_summary: ""
    });
    events.push({
      event_id: `cursor:tool:${request.sessionId}:${request.requestId}:succeeded`,
      session_id: request.sessionId,
      timestamp: toIsoTimestamp(request.completedAt),
      source_vendor: CURSOR_SOURCE_VENDOR,
      source_adapter: CURSOR_SOURCE_ADAPTER,
      workspace_path: request.workspacePath,
      type: "tool.succeeded",
      tool_name: "Composer",
      status: "succeeded",
      duration_ms: Math.max(0, request.completedAt - request.startedAt)
    });

    if (request.filesChanged.length > 0) {
      events.push({
        event_id: `cursor:edit:${request.sessionId}:${request.requestId}`,
        session_id: request.sessionId,
        timestamp: toIsoTimestamp(request.completedAt),
        source_vendor: CURSOR_SOURCE_VENDOR,
        source_adapter: CURSOR_SOURCE_ADAPTER,
        workspace_path: request.workspacePath,
        type: "code.edit.applied",
        tool_name: "Composer",
        files_changed: request.filesChanged,
        file_count: request.filesChanged.length,
        insertions: 0,
        deletions: 0,
        edit_operation_count: 1
      });
    }
  }

  return events;
}

function extractComposers(value: unknown): Array<{
  sessionId: string;
  createdAt: number;
  updatedAt: number | null;
  workspaceId: string | null;
  workspacePath: string | null;
  editSummary: CursorSession["editSummary"];
}> {
  const record = asRecord(value);
  const entries = Array.isArray(record?.allComposers) ? record.allComposers : [];

  return entries
    .map((entry) => {
      const composer = asRecord(entry);
      const sessionId =
        normalizeOptionalString(composer?.composerId) ??
        normalizeOptionalString(composer?.conversationId) ??
        normalizeOptionalString(composer?.id);
      const createdAt = normalizeTimestampMs(composer?.createdAt);
      const updatedAt = normalizeTimestampMs(
        composer?.conversationCheckpointLastUpdatedAt ?? composer?.lastUpdatedAt ?? composer?.updatedAt
      );
      const workspaceIdentifier = asRecord(composer?.workspaceIdentifier);
      const workspaceUri = asRecord(workspaceIdentifier?.uri);
      const workspaceId =
        normalizeOptionalString(workspaceIdentifier?.id) ??
        normalizeOptionalString(composer?.workspaceId) ??
        null;
      const workspacePath =
        normalizePathLike(workspaceUri?.external) ??
        normalizePathLike(workspaceUri?.path) ??
        normalizeOptionalString(workspaceUri?.fsPath) ??
        null;

      if (!sessionId || createdAt === null) {
        return null;
      }

      const filesChanged = normalizeStringArray(
        composer?.changedFiles ?? composer?.filesChanged ?? composer?.filePaths
      );
      const fileCount = normalizeNonNegativeInteger(composer?.filesChangedCount) ?? filesChanged.length;
      const insertions = normalizeNonNegativeInteger(composer?.totalLinesAdded) ?? 0;
      const deletions = normalizeNonNegativeInteger(composer?.totalLinesRemoved) ?? 0;

      return {
        sessionId,
        createdAt,
        updatedAt,
        workspaceId,
        workspacePath,
        editSummary:
          fileCount > 0 || insertions > 0 || deletions > 0
            ? {
                filesChanged,
                fileCount: Math.max(fileCount, filesChanged.length),
                insertions,
                deletions
              }
            : null
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function extractPrompts(value: unknown, workspacePath: string): CursorPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = asRecord(entry);
      const promptId =
        normalizeOptionalString(record?.promptId) ??
        normalizeOptionalString(record?.id) ??
        normalizeOptionalString(record?.requestId);
      const sessionId =
        normalizeOptionalString(record?.composerId) ??
        normalizeOptionalString(record?.conversationId) ??
        normalizeOptionalString(record?.sessionId);
      const createdAt = normalizeTimestampMs(record?.createdAt ?? record?.timestamp ?? record?.time);
      const promptText = extractText(record?.text ?? record?.prompt ?? record?.content ?? record?.message);

      if (!promptId || !sessionId || createdAt === null || promptText.length === 0) {
        return null;
      }

      return {
        eventId: `cursor:prompt:${promptId}`,
        sessionId,
        workspacePath,
        promptId,
        promptChars: promptText.length,
        timestamp: toIsoTimestamp(createdAt)
      } satisfies CursorPrompt;
    })
    .filter((entry): entry is CursorPrompt => entry !== null);
}

function extractGenerations(value: unknown, workspacePath: string): CursorGeneration[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map<CursorGeneration | null>((entry) => {
      const record = asRecord(entry);
      const messageId =
        normalizeOptionalString(record?.messageId) ??
        normalizeOptionalString(record?.id) ??
        normalizeOptionalString(record?.responseId) ??
        normalizeOptionalString(record?.generationId);
      const sessionId =
        normalizeOptionalString(record?.composerId) ??
        normalizeOptionalString(record?.conversationId) ??
        normalizeOptionalString(record?.sessionId);
      const createdAt = normalizeTimestampMs(record?.createdAt ?? record?.timestamp ?? record?.time);
      const responseText = extractText(
        record?.text ?? record?.content ?? record?.response ?? record?.message ?? record?.answer
      );
      const usage = asRecord(record?.usage);

      if (!messageId || !sessionId || createdAt === null) {
        return null;
      }

      return {
        sessionId,
        workspacePath,
        messageId,
        timestamp: toIsoTimestamp(createdAt),
        model:
          normalizeOptionalString(record?.model) ??
          normalizeOptionalString(record?.modelName) ??
          null,
        responseChars: responseText.length,
        inputTokens:
          normalizeNonNegativeInteger(usage?.inputTokens ?? usage?.input_tokens ?? usage?.promptTokens) ??
          null,
        outputTokens:
          normalizeNonNegativeInteger(
            usage?.outputTokens ?? usage?.output_tokens ?? usage?.completionTokens
          ) ?? null,
        cacheReadInputTokens:
          normalizeNonNegativeInteger(
            usage?.cacheReadInputTokens ?? usage?.cache_read_input_tokens
          ) ?? null,
        cacheCreationInputTokens:
          normalizeNonNegativeInteger(
            usage?.cacheCreationInputTokens ?? usage?.cache_creation_input_tokens
          ) ?? null,
        usageSource:
          normalizeNonNegativeInteger(usage?.inputTokens ?? usage?.input_tokens ?? usage?.promptTokens) !== null &&
          normalizeNonNegativeInteger(
            usage?.outputTokens ?? usage?.output_tokens ?? usage?.completionTokens
          ) !== null &&
          normalizeNonNegativeInteger(
            usage?.cacheReadInputTokens ?? usage?.cache_read_input_tokens
          ) !== null &&
          normalizeNonNegativeInteger(
            usage?.cacheCreationInputTokens ?? usage?.cache_creation_input_tokens
          ) !== null
            ? "cursor-generation"
            : null
      };
    })
    .filter((entry): entry is CursorGeneration => entry !== null);
}

async function extractCursorTranscripts(
  cursorProjectsRoot: string,
  sessions: Map<string, CursorSession>,
  sessionIds: Set<string>
): Promise<CursorTranscriptExtraction> {
  const prompts: CursorPrompt[] = [];
  const generations: CursorGeneration[] = [];

  if (sessionIds.size === 0) {
    return { prompts, generations };
  }

  let projectDirs: string[] = [];
  try {
    projectDirs = (await readdir(cursorProjectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cursorProjectsRoot, entry.name));
  } catch {
    return { prompts, generations };
  }

  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    if (!session) {
      continue;
    }

    const existingPrompt = prompts.some((prompt) => prompt.sessionId === sessionId);
    const existingGeneration = generations.some((generation) => generation.sessionId === sessionId);

    if (existingPrompt && existingGeneration) {
      continue;
    }

    const transcriptPath = await findCursorTranscriptPath(projectDirs, sessionId);
    if (!transcriptPath) {
      continue;
    }

    const transcriptText = await readOptionalText(transcriptPath);
    if (!transcriptText) {
      continue;
    }

    let transcriptTimestamp = session.updatedAt ?? session.createdAt ?? Date.now();
    try {
      transcriptTimestamp = (await stat(transcriptPath)).mtime.getTime();
    } catch {
      // Keep the session-derived fallback timestamp.
    }

    const extraction = extractTranscriptEvents({
      session,
      transcriptText,
      transcriptTimestamp,
      includePrompts: !existingPrompt,
      includeGenerations: !existingGeneration
    });
    prompts.push(...extraction.prompts);
    generations.push(...extraction.generations);
  }

  return { prompts, generations };
}

async function findCursorTranscriptPath(projectDirs: string[], sessionId: string): Promise<string | null> {
  for (const projectDir of projectDirs) {
    const transcriptPath = join(projectDir, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
    if (existsSync(transcriptPath)) {
      return transcriptPath;
    }
  }

  return null;
}

function extractTranscriptEvents(input: {
  session: CursorSession;
  transcriptText: string;
  transcriptTimestamp: number;
  includePrompts: boolean;
  includeGenerations: boolean;
}): CursorTranscriptExtraction {
  const prompts: CursorPrompt[] = [];
  const generations: CursorGeneration[] = [];
  const lines = input.transcriptText.split("\n").filter((line) => line.trim().length > 0);
  let lastTimestamp: number | null = null;

  for (const [index, line] of lines.entries()) {
    const parsed = parseJson(line);
    const record = asRecord(parsed);
    const role = normalizeOptionalString(record?.role);
    const lineNumber = index + 1;

    if (role === "user" && input.includePrompts) {
      const promptText = extractTranscriptPromptText(record?.message);
      if (promptText.length === 0) {
        continue;
      }

      const explicitTimestamp = parseTranscriptTimestamp(extractText(asRecord(record?.message)?.content));
      const timestamp = resolveTranscriptTimestamp(lastTimestamp, explicitTimestamp ?? input.transcriptTimestamp, lineNumber);
      lastTimestamp = timestamp;
      prompts.push({
        eventId: `cursor:prompt:transcript:${input.session.sessionId}:${lineNumber}`,
        sessionId: input.session.sessionId,
        workspacePath: input.session.workspacePath,
        promptId: `transcript:${input.session.sessionId}:${lineNumber}`,
        promptChars: promptText.length,
        timestamp: toIsoTimestamp(timestamp)
      });
      continue;
    }

    if (role === "assistant" && input.includeGenerations) {
      const responseText = extractTranscriptAssistantText(record?.message);
      if (responseText.length === 0) {
        continue;
      }

      const timestamp = resolveTranscriptTimestamp(lastTimestamp, input.transcriptTimestamp, lineNumber);
      lastTimestamp = timestamp;
      generations.push({
        sessionId: input.session.sessionId,
        workspacePath: input.session.workspacePath,
        messageId: `transcript:${input.session.sessionId}:${lineNumber}`,
        timestamp: toIsoTimestamp(timestamp),
        model: input.session.model,
        responseChars: responseText.length,
        inputTokens: null,
        outputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        usageSource: null
      });
    }
  }

  return { prompts, generations };
}

async function collectWorkspaceStorageDatabases(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "state.vscdb"))
      .filter((filePath) => existsSync(filePath));
  } catch {
    return [];
  }
}

async function loadWorkspaceLookup(storageJsonPath: string): Promise<Map<string, string>> {
  const parsed = parseJson(await readOptionalText(storageJsonPath));
  const backupWorkspaces = asRecord(asRecord(parsed)?.backupWorkspaces);
  const lookup = new Map<string, string>();

  for (const entry of normalizeWorkspaceEntries(backupWorkspaces?.folders)) {
    if (entry.backupFolder && entry.workspacePath) {
      lookup.set(entry.backupFolder, entry.workspacePath);
    }
  }

  for (const entry of normalizeWorkspaceEntries(backupWorkspaces?.workspaces)) {
    if (entry.backupFolder && entry.workspacePath) {
      lookup.set(entry.backupFolder, entry.workspacePath);
    }
  }

  return lookup;
}

function normalizeWorkspaceEntries(value: unknown): Array<{
  backupFolder: string | null;
  workspacePath: string | null;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      backupFolder: normalizeOptionalString(record?.backupFolder) ?? null,
      workspacePath:
        normalizePathLike(record?.folderUri) ??
        normalizePathLike(record?.workspaceUri) ??
        normalizePathLike(asRecord(record?.workspace)?.configPath) ??
        null
    };
  });
}

function normalizePathLike(value: unknown): string | null {
  const text = normalizeOptionalString(value);
  if (!text) {
    return null;
  }

  if (text.startsWith("file://")) {
    try {
      const url = new URL(text);
      const pathname = decodeURIComponent(url.pathname);

      if (url.host.length > 0) {
        return `//${url.host}${pathname}`;
      }

      if (/^\/[A-Za-z]:\//u.test(pathname)) {
        return pathname.slice(1);
      }

      return pathname;
    } catch {
      return null;
    }
  }

  return text;
}

function ensureSession(
  sessions: Map<string, CursorSession>,
  sessionId: string,
  workspacePath: string
): CursorSession {
  const current = sessions.get(sessionId);
  if (current) {
    if (current.workspacePath === "Cursor" && workspacePath !== "Cursor") {
      current.workspacePath = workspacePath;
    }
    return current;
  }

  const created: CursorSession = {
    sessionId,
    workspacePath,
    createdAt: null,
    updatedAt: null,
    model: null,
    editSummary: null
  };
  sessions.set(sessionId, created);
  return created;
}

async function loadState(cursorPath: string): Promise<CursorState> {
  const parsed = parseJson(await readOptionalText(cursorPath));
  const record = asRecord(parsed);
  return {
    conversationUpdatedAt: normalizeNonNegativeInteger(record?.conversationUpdatedAt) ?? 0,
    composerUpdatedAt: normalizeNonNegativeInteger(record?.composerUpdatedAt) ?? 0,
    promptUpdatedAt: normalizeNonNegativeInteger(record?.promptUpdatedAt) ?? 0,
    generationUpdatedAt: normalizeNonNegativeInteger(record?.generationUpdatedAt) ?? 0
  };
}

async function loadLedger(ledgerPath: string): Promise<EventLedger> {
  const parsed = parseJson(await readOptionalText(ledgerPath));
  const record = asRecord(parsed);

  return {
    eventIds: Array.isArray(record?.eventIds)
      ? record.eventIds.filter((entry): entry is string => typeof entry === "string")
      : []
  };
}

async function loadEventIdsFromEventLog(eventLogPath: string, prefix: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const contents = await readOptionalText(eventLogPath);
  if (!contents) {
    return seen;
  }

  for (const line of contents.split("\n").filter((entry) => entry.length > 0)) {
    const parsed = parseJson(line);
    const eventId = normalizeOptionalString(asRecord(parsed)?.event_id);
    if (eventId?.startsWith(prefix)) {
      seen.add(eventId);
    }
  }

  return seen;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");

  try {
    await rename(tempPath, filePath);
  } catch {
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  }
}

function parseJson(text: string | Uint8Array | null | undefined): unknown {
  const raw =
    typeof text === "string"
      ? text
      : text instanceof Uint8Array
        ? Buffer.from(text).toString("utf8")
        : null;

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractComposerUsageFallbacks(
  rows: Array<{
    key: string;
    value: unknown;
  }>
): Map<string, CursorComposerUsageFallback> {
  const fallbacks = new Map<string, CursorComposerUsageFallback>();

  for (const row of rows) {
    const record = asRecord(parseJson(row.value as string | Uint8Array | null | undefined));
    const sessionId =
      normalizeOptionalString(record?.composerId) ??
      normalizeOptionalString(record?.conversationId) ??
      normalizeOptionalString(record?.id);
    const promptBreakdown = asRecord(record?.promptTokenBreakdown);
    const totalUsedTokens =
      normalizeNonNegativeInteger(promptBreakdown?.totalUsedTokens) ??
      normalizeNonNegativeInteger(record?.contextTokensUsed);

    if (!sessionId || totalUsedTokens === null || totalUsedTokens === 0) {
      continue;
    }

    const modelConfig = asRecord(record?.modelConfig);
    const selectedModels = Array.isArray(modelConfig?.selectedModels) ? modelConfig.selectedModels : [];
    const selectedModel = asRecord(selectedModels[0]);
    const model =
      normalizeOptionalString(selectedModel?.modelId) ??
      normalizeOptionalString(modelConfig?.modelName) ??
      null;

    fallbacks.set(sessionId, {
      sessionId,
      model,
      inputTokens: totalUsedTokens,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0
    });
  }

  return fallbacks;
}

function applyComposerUsageFallbacks(
  generations: CursorGeneration[],
  sessions: Map<string, CursorSession>,
  fallbacks: Map<string, CursorComposerUsageFallback>
): void {
  if (fallbacks.size === 0) {
    return;
  }

  for (const fallback of fallbacks.values()) {
    const target = [...generations]
      .reverse()
      .find(
        (generation) =>
          generation.sessionId === fallback.sessionId &&
          generation.responseChars > 0 &&
          generation.inputTokens === null &&
          generation.outputTokens === null &&
          generation.cacheReadInputTokens === null &&
          generation.cacheCreationInputTokens === null
      );

    if (!target) {
      continue;
    }

    target.inputTokens = fallback.inputTokens;
    target.outputTokens = fallback.outputTokens;
    target.cacheReadInputTokens = fallback.cacheReadInputTokens;
    target.cacheCreationInputTokens = fallback.cacheCreationInputTokens;
    target.usageSource = "cursor-composer-context";
    target.model = target.model ?? fallback.model ?? sessions.get(fallback.sessionId)?.model ?? null;
  }
}

function hasTable(db: ReadOnlyDatabase, tableName: string): boolean {
  const row = db
    .prepare<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = ?`
    )
    .get(tableName);

  return row !== undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractText(entry)).filter((entry) => entry.length > 0).join("\n");
  }

  const record = asRecord(value);
  if (record === null) {
    return "";
  }

  return (
    extractText(record.text) ||
    extractText(record.content) ||
    extractText(record.message) ||
    extractText(record.value)
  );
}

function extractTranscriptPromptText(value: unknown): string {
  const text = extractText(asRecord(value)?.content ?? value);
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/u.exec(text);
  return (match?.[1] ?? text).trim();
}

function extractTranscriptAssistantText(value: unknown): string {
  const content = Array.isArray(asRecord(value)?.content) ? (asRecord(value)?.content as unknown[]) : [];
  const segments = content
    .map((entry) => {
      const record = asRecord(entry);
      return normalizeOptionalString(record?.type) === "text" ? extractText(record?.text) : "";
    })
    .filter((entry) => entry.length > 0);

  return segments.join("\n").trim();
}

function parseTranscriptTimestamp(value: string): number | null {
  const match = /<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/u.exec(value);
  const raw = match?.[1]?.trim();
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(
    /\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)/u,
    (_whole, hours: string, minutes?: string) => {
      const sign = hours.startsWith("-") ? "-" : "+";
      const absoluteHours = hours.replace(/^[-+]/u, "").padStart(2, "0");
      const absoluteMinutes = (minutes ?? "00").padStart(2, "0");
      return `GMT${sign}${absoluteHours}${absoluteMinutes}`;
    }
  );
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function resolveTranscriptTimestamp(
  lastTimestamp: number | null,
  fallbackTimestamp: number,
  lineNumber: number
): number {
  if (lastTimestamp === null) {
    return fallbackTimestamp + lineNumber;
  }

  return Math.max(lastTimestamp + 1, fallbackTimestamp + lineNumber);
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.trunc(asNumber);
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  return null;
}

function toIsoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function parseIsoTimestamp(value: string): number {
  return new Date(value).getTime();
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function parseCursorHashFiles(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return [...new Set(value
    .split(",")
    .map((entry) => normalizeCursorTrackedPath(entry))
    .filter((entry): entry is string => entry.length > 0))];
}

function normalizeCursorTrackedPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (/^\/[A-Za-z]:\//u.test(trimmed)) {
    return trimmed.slice(1);
  }

  return trimmed;
}

function inferWorkspacePathFromFiles(files: string[]): string | null {
  if (files.length === 0) {
    return null;
  }

  const segmentSets = files.map((filePath) => {
    const normalized = normalizeCursorTrackedPath(filePath).replaceAll("\\", "/");
    return normalized.split("/").filter((segment) => segment.length > 0);
  });

  if (segmentSets.length === 0 || segmentSets[0]?.length === 0) {
    return null;
  }

  const commonSegments: string[] = [];
  const minLength = Math.min(...segmentSets.map((segments) => segments.length));

  for (let index = 0; index < minLength; index += 1) {
    const segment = segmentSets[0]?.[index];
    if (!segment || segmentSets.some((segments) => segments[index] !== segment)) {
      break;
    }
    commonSegments.push(segment);
  }

  if (commonSegments.length === 0) {
    return null;
  }

  if (commonSegments.length === 1 && commonSegments[0]?.endsWith(":")) {
    return `${commonSegments[0]}/`;
  }

  return commonSegments.join("/");
}

function maxCursorValue(current: number, values: number[]): number {
  return values.reduce((max, value) => (value > max ? value : max), current);
}

function minNullableNumber(left: number | null, right: number): number {
  return left === null ? right : Math.min(left, right);
}

function maxNullableNumber(left: number | null, right: number): number {
  return left === null ? right : Math.max(left, right);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function compareCursorEvents(left: AnyEvent, right: AnyEvent): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp.localeCompare(right.timestamp);
  }

  const leftRank = getCursorEventRank(left.type);
  const rightRank = getCursorEventRank(right.type);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return left.event_id.localeCompare(right.event_id);
}

function getCursorEventRank(type: AnyEvent["type"]): number {
  switch (type) {
    case "session.started":
      return 0;
    case "prompt.submitted":
      return 1;
    case "assistant.responded":
      return 2;
    case "token.usage.recorded":
      return 3;
    case "code.edit.applied":
      return 4;
    default:
      return 5;
  }
}
