import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

export async function syncCursorArtifacts(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  trackingDbPath?: string;
  workspaceStorageRoot?: string;
  storageJsonPath?: string;
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

  if (!existsSync(trackingDbPath) && !existsSync(workspaceStorageRoot)) {
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

  const events = buildCursorEvents({
    sessions,
    prompts,
    generations
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
        usage_source: "cursor-generation",
        provider_id: null,
        provider_base_url: null,
        provider_host: null
      });
    }
  }

  return events;
}

function extractComposers(value: unknown): Array<{
  sessionId: string;
  createdAt: number;
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
          ) ?? null
      };
    })
    .filter((entry): entry is CursorGeneration => entry !== null);
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

function parseJson(text: string | null | undefined): unknown {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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
