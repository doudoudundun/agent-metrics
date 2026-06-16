import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { SourceAdapter } from "@agent-metrics/event-schema";
import {
  appendJsonLine,
  loadEventLedgerWithFallback,
  persistEventLedger
} from "@agent-metrics/shared-utils";
import {
  normalizeOpenCodePartRow,
  normalizeOpenCodeMessageRow,
  normalizeOpenCodeSessionRow,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
  type OpenCodeProviderRegistry,
  type OpenCodeSessionRow
} from "./opencode.js";

type SyncCursor = {
  sessionUpdatedAt: number;
  messageUpdatedAt: number;
  partUpdatedAt: number;
  pendingMessageIds: string[];
};

type MultiSourceSyncCursor = {
  sources: Record<string, SyncCursor>;
};

type SessionLookupRow = {
  id: string;
  directory: string;
  model: string | null;
};

type ReadOnlyDatabase = {
  close(): void;
  prepare<Result = unknown>(sql: string): {
    all(...params: unknown[]): Result[];
  };
};

type OpenCodeSourceDefinition = {
  key: string;
  dbPath: string;
  modelsPath: string;
  eventNamespace: string | null;
  sourceAdapter: SourceAdapter;
};

const EMPTY_CURSOR: SyncCursor = {
  sessionUpdatedAt: 0,
  messageUpdatedAt: 0,
  partUpdatedAt: 0,
  pendingMessageIds: []
};

const LEGACY_CURSOR_KEY = "opencode";

function asSourceAdapter(value: string): SourceAdapter {
  return value as SourceAdapter;
}

export function resolveDefaultOpenCodeDbPath(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

export function resolveDefaultOpenCodeModelsPath(): string {
  return join(homedir(), ".cache", "opencode", "models.json");
}

export function resolveDefaultZCodeDbPath(): string {
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export function resolveDefaultZCodeModelsPath(): string {
  return join(homedir(), ".cache", "zcode", "models.json");
}

export async function syncOpenCodeDatabase(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  dbPath?: string;
  modelsPath?: string;
  extraSources?: Array<{
    key: string;
    dbPath: string;
    modelsPath?: string;
    eventNamespace?: string | null;
    sourceAdapter?: SourceAdapter;
  }>;
}): Promise<void> {
  const primaryDbPath =
    input.dbPath ??
    process.env.AGENT_METRICS_OPENCODE_DB_PATH ??
    resolveDefaultOpenCodeDbPath();
  const primaryModelsPath =
    input.modelsPath ??
    process.env.AGENT_METRICS_OPENCODE_MODELS_PATH ??
    resolveDefaultOpenCodeModelsPath();
  const zcodeDbPath =
    process.env.AGENT_METRICS_ZCODE_DB_PATH ??
    resolveDefaultZCodeDbPath();
  const zcodeModelsPath =
    process.env.AGENT_METRICS_ZCODE_MODELS_PATH ??
    resolveDefaultZCodeModelsPath();
  const sourceDefinitions: OpenCodeSourceDefinition[] = [
    {
      key: LEGACY_CURSOR_KEY,
      dbPath: primaryDbPath,
      modelsPath: primaryModelsPath,
      eventNamespace: null,
      sourceAdapter: asSourceAdapter("opencode-db")
    },
    {
      key: "zcode",
      dbPath: zcodeDbPath,
      modelsPath: zcodeModelsPath,
      eventNamespace: "zcode",
      sourceAdapter: asSourceAdapter("zcode-db")
    },
    ...(input.extraSources ?? []).map((source): OpenCodeSourceDefinition => ({
      key: source.key,
      dbPath: source.dbPath,
      modelsPath: source.modelsPath ?? primaryModelsPath,
      eventNamespace: source.eventNamespace ?? source.key,
      sourceAdapter: source.sourceAdapter ?? asSourceAdapter("opencode-db")
    }))
  ].filter((source, index, allSources) =>
    allSources.findIndex((entry) => entry.key === source.key) === index
  );

  if (!sourceDefinitions.some((source) => existsSync(source.dbPath))) {
    return;
  }

  const cursorState = await loadCursorState(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: "opencode:"
  });
  const baselineEventCount = seenEventIds.size;

  let ledgerChanged = false;
  let cursorChanged = false;

  for (const source of sourceDefinitions) {
    if (!existsSync(source.dbPath)) {
      continue;
    }

    const providerRegistry = await loadProviderRegistry(source.modelsPath);
    const nextCursor = await syncSingleSource({
      source,
      cursor: cursorState.sources[source.key] ?? EMPTY_CURSOR,
      eventLogPath: input.eventLogPath,
      seenEventIds,
      providerRegistry
    });

    if (!isSameCursor(nextCursor, cursorState.sources[source.key] ?? EMPTY_CURSOR)) {
      cursorState.sources[source.key] = nextCursor;
      cursorChanged = true;
    }

    if (seenEventIds.size !== baselineEventCount) {
      ledgerChanged = true;
    }
  }

  if (cursorChanged) {
    await writeJsonFileAtomic(input.cursorPath, cursorState);
  }

  if (ledgerChanged) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }
}

async function syncSingleSource(input: {
  source: OpenCodeSourceDefinition;
  cursor: SyncCursor;
  eventLogPath: string;
  seenEventIds: Set<string>;
  providerRegistry: OpenCodeProviderRegistry;
}): Promise<SyncCursor> {
  const db = new Database(input.source.dbPath, {
    readonly: true,
    fileMustExist: true
  }) as ReadOnlyDatabase;

  try {
    const sessionRows = db
      .prepare<OpenCodeSessionRow>(
        `SELECT
          id,
          directory,
          time_created,
          time_updated,
          time_archived,
          NULL AS model
        FROM session
        WHERE time_updated >= ?
        ORDER BY time_updated ASC, id ASC`
      )
      .all(input.cursor.sessionUpdatedAt);
    const messageRows = db
      .prepare<OpenCodeMessageRow>(
        `SELECT
          id,
          session_id,
          time_created,
          time_updated,
          data
        FROM message
        WHERE time_updated >= ?
        ORDER BY time_updated ASC, id ASC`
      )
      .all(input.cursor.messageUpdatedAt);
    const pendingMessageRows = selectMessagesByIds(
      db,
      input.cursor.pendingMessageIds,
      new Set(messageRows.map((row) => row.id))
    );
    const allMessageRows = dedupeMessageRows([...messageRows, ...pendingMessageRows]);
    const updatedToolRows = db
      .prepare<OpenCodePartRow>(
        `SELECT
          id,
          message_id,
          session_id,
          time_created,
          time_updated,
          data
        FROM part
        WHERE time_updated >= ?
        ORDER BY time_updated ASC, id ASC`
      )
      .all(input.cursor.partUpdatedAt);
    const partMessageRows = selectMessagesByIds(
      db,
      [...new Set(updatedToolRows.map((row) => row.message_id))],
      new Set(allMessageRows.map((row) => row.id))
    );
    const allKnownMessageRows = dedupeMessageRows([...allMessageRows, ...partMessageRows]);
    const messagePartRows = selectPartsByMessageIds(db, allKnownMessageRows.map((row) => row.id));
    const sessionLookup = loadSessionLookup(
      db,
      new Set([
        ...sessionRows.map((row) => row.id),
        ...allKnownMessageRows.map((row) => row.session_id),
        ...updatedToolRows.map((row) => row.session_id)
      ])
    );
    const messageLookup = new Map(allKnownMessageRows.map((row) => [row.id, row]));
    const partRowsByMessageId = new Map<string, OpenCodePartRow[]>();

    for (const row of messagePartRows) {
      const existing = partRowsByMessageId.get(row.message_id);
      if (existing) {
        existing.push(row);
      } else {
        partRowsByMessageId.set(row.message_id, [row]);
      }
    }

    const events = [
      ...sessionRows.flatMap((row) =>
        normalizeOpenCodeSessionRow(row, {
          eventNamespace: input.source.eventNamespace,
          sourceAdapter: input.source.sourceAdapter
        })
      ),
      ...allMessageRows.flatMap((row) => {
        const session = sessionLookup.get(row.session_id);

        return normalizeOpenCodeMessageRow({
          row,
          sessionDirectory: session?.directory ?? null,
          sessionModel: session?.model ?? null,
          partRows: partRowsByMessageId.get(row.id) ?? [],
          providerRegistry: input.providerRegistry,
          eventContext: {
            eventNamespace: input.source.eventNamespace,
            sourceAdapter: input.source.sourceAdapter
          }
        });
      }),
      ...updatedToolRows.flatMap((row) => {
        const session = sessionLookup.get(row.session_id);
        const message = messageLookup.get(row.message_id) ?? null;

        return normalizeOpenCodePartRow({
          row,
          sessionDirectory: session?.directory ?? null,
          sessionModel: session?.model ?? null,
          messageRow: message,
          providerRegistry: input.providerRegistry,
          eventContext: {
            eventNamespace: input.source.eventNamespace,
            sourceAdapter: input.source.sourceAdapter
          }
        });
      })
    ].sort((left, right) =>
      left.timestamp === right.timestamp
        ? left.event_id.localeCompare(right.event_id)
        : left.timestamp.localeCompare(right.timestamp)
    );

    for (const event of events) {
      if (input.seenEventIds.has(event.event_id)) {
        continue;
      }

      await appendJsonLine(input.eventLogPath, event);
      input.seenEventIds.add(event.event_id);
    }

    return {
      sessionUpdatedAt: maxCursorValue(input.cursor.sessionUpdatedAt, sessionRows.map((row) => row.time_updated)),
      messageUpdatedAt: maxCursorValue(input.cursor.messageUpdatedAt, messageRows.map((row) => row.time_updated)),
      partUpdatedAt: maxCursorValue(input.cursor.partUpdatedAt, updatedToolRows.map((row) => row.time_updated)),
      pendingMessageIds: collectPendingMessageIds(allMessageRows, input.seenEventIds, input.source.eventNamespace)
    };
  } finally {
    db.close();
  }
}

function selectPartsByMessageIds(db: ReadOnlyDatabase, messageIds: string[]): OpenCodePartRow[] {
  if (messageIds.length === 0) {
    return [];
  }

  const placeholders = messageIds.map(() => "?").join(", ");

  return db
    .prepare<OpenCodePartRow>(
      `SELECT
        id,
        message_id,
        session_id,
        time_created,
        time_updated,
        data
      FROM part
      WHERE message_id IN (${placeholders})
      ORDER BY time_created ASC, id ASC`
    )
    .all(...messageIds);
}

function selectMessagesByIds(
  db: ReadOnlyDatabase,
  messageIds: string[],
  excludeMessageIds?: Set<string>
): OpenCodeMessageRow[] {
  const ids = messageIds.filter((messageId) => !excludeMessageIds?.has(messageId));
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");

  return db
    .prepare<OpenCodeMessageRow>(
      `SELECT
        id,
        session_id,
        time_created,
        time_updated,
        data
      FROM message
      WHERE id IN (${placeholders})
      ORDER BY time_updated ASC, id ASC`
    )
    .all(...ids);
}

function dedupeMessageRows(rows: OpenCodeMessageRow[]): OpenCodeMessageRow[] {
  const deduped = new Map<string, OpenCodeMessageRow>();

  for (const row of rows) {
    deduped.set(row.id, row);
  }

  return [...deduped.values()].sort((left, right) =>
    left.time_updated === right.time_updated
      ? left.id.localeCompare(right.id)
      : left.time_updated - right.time_updated
  );
}

function loadSessionLookup(db: ReadOnlyDatabase, sessionIds: Set<string>): Map<string, SessionLookupRow> {
  if (sessionIds.size === 0) {
    return new Map();
  }

  const values = [...sessionIds];
  const placeholders = values.map(() => "?").join(", ");
  const rows = db
    .prepare<SessionLookupRow>(
      `SELECT id, directory, NULL AS model FROM session WHERE id IN (${placeholders})`
    )
    .all(...values);

  return new Map(rows.map((row) => [row.id, row]));
}

async function loadCursorState(cursorPath: string): Promise<MultiSourceSyncCursor> {
  const parsed = await readJsonFile(cursorPath);
  if (parsed === null) {
    return { sources: {} };
  }

  const sourcesValue = parsed.sources;
  if (isRecord(sourcesValue)) {
    return {
      sources: Object.fromEntries(
        Object.entries(sourcesValue).map(([key, value]) => [key, parseSingleCursor(value)])
      )
    };
  }

  return {
    sources: {
      [LEGACY_CURSOR_KEY]: parseSingleCursor(parsed)
    }
  };
}

function parseSingleCursor(value: unknown): SyncCursor {
  const record = isRecord(value) ? value : null;

  return {
    sessionUpdatedAt: normalizeCursorValue(record, "sessionUpdatedAt"),
    messageUpdatedAt: normalizeCursorValue(record, "messageUpdatedAt"),
    partUpdatedAt: normalizeCursorValue(record, "partUpdatedAt"),
    pendingMessageIds: normalizeStringArray(record, "pendingMessageIds")
  };
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
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

function normalizeCursorValue(
  value: Record<string, unknown> | null,
  key: keyof SyncCursor
): number {
  if (!value) {
    return 0;
  }

  const raw = value[key];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

function normalizeStringArray(
  value: Record<string, unknown> | null,
  key: "pendingMessageIds"
): string[] {
  if (!value) {
    return [];
  }

  const raw = value[key];
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

function maxCursorValue(current: number, values: number[]): number {
  return values.reduce((max, value) => (value > max ? value : max), current);
}

function isSameCursor(left: SyncCursor, right: SyncCursor): boolean {
  return (
    left.sessionUpdatedAt === right.sessionUpdatedAt &&
    left.messageUpdatedAt === right.messageUpdatedAt &&
    left.partUpdatedAt === right.partUpdatedAt &&
    isSameStringArray(left.pendingMessageIds, right.pendingMessageIds)
  );
}

function isSameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectPendingMessageIds(
  messageRows: OpenCodeMessageRow[],
  seenEventIds: Set<string>,
  eventNamespace: string | null
): string[] {
  const pending = new Set<string>();

  for (const row of messageRows) {
    if (shouldRetryMessageForTokens(row, seenEventIds, eventNamespace)) {
      pending.add(row.id);
    }
  }

  return [...pending].sort();
}

function shouldRetryMessageForTokens(
  row: OpenCodeMessageRow,
  seenEventIds: Set<string>,
  eventNamespace: string | null
): boolean {
  const inspection = inspectOpenCodeMessage(row.data);
  if (inspection.role !== "assistant" || inspection.hasTokens) {
    return false;
  }

  return !seenEventIds.has(buildOpenCodeUsageEventId(row.id, eventNamespace));
}

function inspectOpenCodeMessage(data: string): {
  role: string | null;
  hasTokens: boolean;
} {
  try {
    const parsed = JSON.parse(data) as unknown;
    const record = isRecord(parsed) ? parsed : null;
    if (record === null) {
      return {
        role: null,
        hasTokens: false
      };
    }

    return {
      role: normalizeNonEmptyString(record.role),
      hasTokens: hasOpenCodeTokenPayload(record)
    };
  } catch {
    return {
      role: null,
      hasTokens: false
    };
  }
}

function hasOpenCodeTokenPayload(message: Record<string, unknown>): boolean {
  const tokens = isRecord(message.tokens) ? message.tokens : null;
  if (tokens === null) {
    return false;
  }

  const cache = isRecord(tokens.cache) ? tokens.cache : null;
  const inputTokens = normalizeInteger(tokens.input) ?? 0;
  const outputTokens =
    (normalizeInteger(tokens.output) ?? 0) + (normalizeInteger(tokens.reasoning) ?? 0);
  const cacheCreationTokens = normalizeInteger(cache?.write) ?? 0;
  const cacheReadTokens = normalizeInteger(cache?.read) ?? 0;

  return (
    inputTokens > 0 ||
    outputTokens > 0 ||
    cacheCreationTokens > 0 ||
    cacheReadTokens > 0
  );
}

function buildOpenCodeUsageEventId(messageId: string, eventNamespace: string | null): string {
  return eventNamespace
    ? `opencode:${eventNamespace}:message:${messageId}:usage`
    : `opencode:message:${messageId}:usage`;
}

async function loadProviderRegistry(modelsPath: string): Promise<OpenCodeProviderRegistry> {
  if (!existsSync(modelsPath)) {
    return {};
  }

  const parsed = await readJsonFile(modelsPath);
  if (parsed === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).flatMap(([providerId, value]) => {
      if (!isRecord(value)) {
        return [];
      }

      const baseUrl = normalizeNonEmptyString(value.api);
      return [
        [
          providerId,
          {
            baseUrl,
            host: extractHost(baseUrl)
          }
        ] as const
      ];
    })
  );
}

function extractHost(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
