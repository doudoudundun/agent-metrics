import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AnyEventSchema,
  SourceVendorSchema,
  normalizeEventV2,
  sha256Hex,
  type AnyEvent,
  type NormalizedEventV2,
  type SourceVendor
} from "@agent-metrics/event-schema";
import type { ClaudeSessionContext } from "@agent-metrics/adapters-claude";
import {
  acquireCanonicalLease,
  createEventLogCursor,
  readEventLogIncremental,
  releaseCanonicalLease,
  type EventLogCursor
} from "./raw-ingest.js";
import {
  projectNormalizedEventsInTransaction,
  recordProjectionDiagnostic
} from "./domain-projection.js";
import type { SqliteDatabaseLike } from "./domain-migrations.js";

type MetricsStatement<Result = unknown> = {
  all(...params: unknown[]): Result[];
  get(...params: unknown[]): Result;
  run(...params: unknown[]): unknown;
};

export type EventProjectorDatabase = SqliteDatabaseLike & {
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult;
};

export type EventProjectorLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};

export type EventLogSignature = {
  mtimeMs: number;
  size: number;
};

type PendingProjectionDiagnostic = {
  diagnosticCode: string;
  sourceInstanceId: string;
  eventId: string;
  evidenceFingerprint: string;
  summary: string;
  locator?: string | null;
  resolverVersion?: string | null;
};

export type EventLogSynchronizer = () => Promise<void>;

export function readProjectionWatermark(db: EventProjectorDatabase): number {
  const row = db.prepare<{ count: number }>(
    "SELECT COUNT(*) AS count FROM normalized_events"
  ).get();
  return typeof row?.count === "number" && Number.isSafeInteger(row.count) && row.count >= 0
    ? row.count
    : 0;
}

export function createEventLogSynchronizer(input: {
  eventLogPath: string;
  /**
   * Read+project one chunk. Return `atEnd: true` when the cursor has caught the
   * file (or there is nothing left to read).
   */
  ingest: () => Promise<{ atEnd: boolean }>;
}): EventLogSynchronizer {
  let lastFullyDrainedSignature: EventLogSignature | null = null;
  let syncQueue: Promise<void> = Promise.resolve();

  return async () => {
    const run = syncQueue.catch(() => undefined).then(async () => {
      const nextSignature = await readEventLogSignature(input.eventLogPath);
      if (nextSignature === null) {
        lastFullyDrainedSignature = null;
        return;
      }
      // Skip only when this exact file snapshot was already fully drained.
      if (isSameEventLogSignature(nextSignature, lastFullyDrainedSignature)) {
        return;
      }

      // Each ingest chunk reads a bounded window (~1MB). Keep going until caught up.
      let guard = 0;
      while (guard < 512) {
        guard += 1;
        const { atEnd } = await input.ingest();
        if (atEnd) {
          lastFullyDrainedSignature = nextSignature;
          break;
        }
        if (shouldYieldDuringIngest()) {
          await yieldEventLoop();
        }
      }
    });
    syncQueue = run;
    await run;
  };
}

/** Let the HTTP event loop flush (health / sync-status) between sync batches. */
export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const INGEST_YIELD_EVERY = 50;

function shouldYieldDuringIngest(): boolean {
  return process.env.AGENT_METRICS_INGEST_NO_YIELD !== "1";
}

export async function ingestEventLog(input: {
  db: EventProjectorDatabase;
  eventLogPath: string;
  logger?: EventProjectorLogger;
  maxBytes?: number;
}): Promise<{ atEnd: boolean }> {
  const signature = await readEventLogSignature(input.eventLogPath);
  if (signature === null) {
    return { atEnd: true };
  }

  let readResult;
  try {
    readResult = await readEventLogIncremental({
      filePath: input.eventLogPath,
      cursor: readIncrementalCursor(input.db),
      maxBytes: input.maxBytes
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return { atEnd: true };
    }
    throw error;
  }

  const { records, malformedLines } = readResult;
  if (records.length === 0) {
    persistProjectionBatch({
      db: input.db,
      parsedEvents: [],
      normalizedEvents: [],
      diagnostics: [],
      cursor: readResult.nextCursor,
      signature
    });
    return { atEnd: true };
  }

  const parsedEvents: AnyEvent[] = [];
  const normalizedEvents: NormalizedEventV2[] = [];
  const diagnostics: PendingProjectionDiagnostic[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (shouldYieldDuringIngest() && index > 0 && index % INGEST_YIELD_EVERY === 0) {
      await yieldEventLoop();
    }
    const record = records[index]!;
    const { line, offsetBytes: lineOffset } = record;
    const malformed = malformedLines.find((entry) => entry.offsetBytes === lineOffset);
    if (malformed !== undefined) {
      diagnostics.push({
        diagnosticCode: "MALFORMED_JSONL",
        sourceInstanceId: "unknown:default",
        eventId: `legacy:malformed:${malformed.offsetBytes}`,
        evidenceFingerprint: sha256Hex(line),
        summary: "The event log line is not valid JSON.",
        locator: `${input.eventLogPath}:${malformed.offsetBytes}`,
        resolverVersion: "phase3-incremental-reader"
      });
      continue;
    }

    let rawValue: unknown;
    try {
      rawValue = JSON.parse(line);
    } catch (error) {
      diagnostics.push({
        diagnosticCode: "MALFORMED_JSONL",
        sourceInstanceId: "unknown:default",
        eventId: `legacy:malformed:${lineOffset}`,
        evidenceFingerprint: sha256Hex(line),
        summary: "The event log line is not valid JSON.",
        locator: `${input.eventLogPath}:${lineOffset}`,
        resolverVersion: "phase3-incremental-reader"
      });
      input.logger?.warn(
        {
          offsetBytes: lineOffset,
          preview: line.length > 200 ? `${line.slice(0, 200)}...` : line,
          error
        },
        "skipped malformed event log line"
      );
      continue;
    }

    let parsed: AnyEvent;
    try {
      parsed = AnyEventSchema.parse(rawValue);
    } catch (error) {
      diagnostics.push({
        diagnosticCode: "INVALID_EVENT",
        sourceInstanceId: sourceInstanceIdForVendor(parsedSourceVendor(rawValue)),
        eventId: `legacy:invalid:${lineOffset}`,
        evidenceFingerprint: sha256Hex(line),
        summary: "The event log record failed the legacy event schema.",
        locator: `${input.eventLogPath}:${lineOffset}`,
        resolverVersion: "phase3-incremental-reader"
      });
      input.logger?.warn(
        {
          offsetBytes: lineOffset,
          preview: line.length > 200 ? `${line.slice(0, 200)}...` : line,
          error
        },
        "skipped invalid event log line"
      );
      continue;
    }

    const normalized = normalizeEventV2(rawValue, {
      sourceRecordId: sourceRecordIdForNormalization(parsed),
      sourceSequence: lineOffset,
      sourceLocation: {
        eventLogPath: input.eventLogPath,
        byteOffset: lineOffset
      }
    });
    if (normalized.ok) {
      normalizedEvents.push(normalized.event);
    } else {
      diagnostics.push({
        diagnosticCode: normalized.diagnosticCode,
        sourceInstanceId: sourceInstanceIdForVendor(parsed.source_vendor),
        eventId: parsed.event_id,
        evidenceFingerprint: sha256Hex(line),
        summary: normalized.message,
        locator: `${input.eventLogPath}:${lineOffset}`,
        resolverVersion: "phase2-normalizer"
      });
    }
    parsedEvents.push(parsed);
  }

  persistProjectionBatch({
    db: input.db,
    parsedEvents,
    normalizedEvents,
    diagnostics,
    cursor: readResult.nextCursor,
    signature
  });
  return {
    atEnd: readResult.nextCursor.committedOffset >= signature.size
  };
}

export function persistClaudeSessionContexts(
  db: EventProjectorDatabase,
  contexts: readonly ClaudeSessionContext[]
): void {
  const persist = db.transaction((items: readonly ClaudeSessionContext[]) => {
    const ensureSession = db.prepare(
      "INSERT OR IGNORE INTO sessions (session_id, started_at, workspace_path, source_vendor, source_adapter, ended_at, exit_code) VALUES (?, ?, ?, ?, ?, NULL, NULL)"
    );
    const updateContext = db.prepare(
      `
        INSERT INTO session_contexts (
          session_id, source_vendor, source_adapter, execution_path,
          skills_loaded, skill_names_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          source_vendor = excluded.source_vendor,
          source_adapter = excluded.source_adapter,
          execution_path = excluded.execution_path,
          skills_loaded = excluded.skills_loaded,
          skill_names_json = excluded.skill_names_json,
          updated_at = excluded.updated_at
      `
    );
    for (const context of items) {
      ensureSession.run(
        context.sessionId,
        context.updatedAt,
        context.workspacePath,
        context.sourceVendor,
        context.sourceAdapter
      );
      updateContext.run(
        context.sessionId,
        context.sourceVendor,
        context.sourceAdapter,
        context.executionPath,
        context.skillsLoaded ? 1 : 0,
        JSON.stringify(context.skillNames),
        context.updatedAt
      );
    }
  });
  persist(contexts);
}

function persistProjectionBatch(input: {
  db: EventProjectorDatabase;
  parsedEvents: readonly AnyEvent[];
  normalizedEvents: readonly NormalizedEventV2[];
  diagnostics: readonly PendingProjectionDiagnostic[];
  cursor: EventLogCursor;
  signature: EventLogSignature;
}): void {
  const persist = input.db.transaction(() => {
    for (const diagnostic of input.diagnostics) {
      recordProjectionDiagnostic({ db: input.db, ...diagnostic });
    }
    persistLegacyEventsInTransaction(input.db, input.parsedEvents);
    projectNormalizedEventsInTransaction(input.db, input.normalizedEvents, new Date().toISOString());
    writeIncrementalCursor(input.db, input.cursor, input.signature);
  });
  persist();
}

function persistLegacyEventsInTransaction(
  db: EventProjectorDatabase,
  events: readonly AnyEvent[]
): void {
    const startSession = db.prepare(
      `
        INSERT INTO sessions (
          session_id, started_at, workspace_path, source_vendor,
          source_adapter, ended_at, exit_code
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(session_id) DO UPDATE SET
          started_at = excluded.started_at,
          workspace_path = excluded.workspace_path,
          source_vendor = excluded.source_vendor,
          source_adapter = excluded.source_adapter
      `
    );
    const ensureSession = db.prepare(
      "INSERT OR IGNORE INTO sessions (session_id, started_at, workspace_path, source_vendor, source_adapter, ended_at, exit_code) VALUES (?, ?, ?, ?, ?, NULL, NULL)"
    );
    const endSession = db.prepare(
      "UPDATE sessions SET ended_at = ?, exit_code = ?, workspace_path = ?, source_vendor = ?, source_adapter = ? WHERE session_id = ?"
    );
    const toolEvent = db.prepare(
      "INSERT OR REPLACE INTO tool_events (event_id, session_id, tool_name, status, duration_ms, source_vendor, source_adapter, created_at, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const promptEvent = db.prepare(
      "INSERT OR REPLACE INTO prompt_events (event_id, session_id, prompt_id, prompt_chars, source_vendor, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const assistantResponse = db.prepare(
      "INSERT OR REPLACE INTO assistant_responses (event_id, session_id, message_id, model, stop_reason, response_chars, source_vendor, source_adapter, provider_id, provider_base_url, provider_host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const tokenUsage = db.prepare(
      "INSERT OR REPLACE INTO token_usage_events (event_id, session_id, message_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use, usage_source, source_vendor, source_adapter, provider_id, provider_base_url, provider_host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const codeEdit = db.prepare(
      "INSERT OR REPLACE INTO code_edits (event_id, session_id, tool_name, files_changed, file_count, insertions, deletions, edit_operation_count, source_vendor, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    for (const parsed of events) {
      const sourceAdapter = normalizeSourceAdapterForStorage(parsed);
      if (parsed.type === "session.started") {
        startSession.run(
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          parsed.source_vendor,
          sourceAdapter
        );
      }
      if (parsed.type === "session.ended") {
        ensureSession.run(
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          parsed.source_vendor,
          sourceAdapter
        );
        endSession.run(
          parsed.timestamp,
          parsed.exit_code ?? null,
          parsed.workspace_path,
          parsed.source_vendor,
          sourceAdapter,
          parsed.session_id
        );
      }
      if (parsed.type === "tool.called" || parsed.type === "tool.succeeded" || parsed.type === "tool.failed") {
        toolEvent.run(
          parsed.event_id,
          parsed.session_id,
          parsed.tool_name,
          parsed.status,
          parsed.type === "tool.called" ? 0 : parsed.duration_ms,
          parsed.source_vendor,
          sourceAdapter,
          parsed.timestamp,
          toolCallIdForLegacyStorage(parsed)
        );
      }
      if (parsed.type === "prompt.submitted") {
        ensureSession.run(
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          parsed.source_vendor,
          sourceAdapter
        );
        promptEvent.run(
          parsed.event_id,
          parsed.session_id,
          parsed.prompt_id,
          parsed.prompt_chars,
          parsed.source_vendor,
          sourceAdapter,
          parsed.timestamp
        );
      }
      if (parsed.type === "assistant.responded") {
        ensureSession.run(
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          parsed.source_vendor,
          sourceAdapter
        );
        assistantResponse.run(
          parsed.event_id,
          parsed.session_id,
          parsed.message_id,
          parsed.model ?? null,
          parsed.stop_reason ?? null,
          parsed.response_chars,
          parsed.source_vendor,
          sourceAdapter,
          parsed.provider_id ?? null,
          parsed.provider_base_url ?? null,
          parsed.provider_host ?? null,
          parsed.timestamp
        );
      }
      if (parsed.type === "token.usage.recorded") {
        ensureSession.run(
          parsed.session_id,
          parsed.timestamp,
          parsed.workspace_path,
          parsed.source_vendor,
          sourceAdapter
        );
        tokenUsage.run(
          parsed.event_id,
          parsed.session_id,
          parsed.message_id,
          parsed.model ?? null,
          parsed.input_tokens,
          parsed.output_tokens,
          parsed.cache_creation_input_tokens,
          parsed.cache_read_input_tokens,
          parsed.server_tool_use,
          parsed.usage_source,
          parsed.source_vendor,
          sourceAdapter,
          parsed.provider_id ?? null,
          parsed.provider_base_url ?? null,
          parsed.provider_host ?? null,
          parsed.timestamp
        );
      }
      if (parsed.type === "code.edit.applied") {
        codeEdit.run(
          parsed.event_id,
          parsed.session_id,
          parsed.tool_name,
          JSON.stringify(parsed.files_changed),
          parsed.file_count,
          parsed.insertions,
          parsed.deletions,
          parsed.edit_operation_count,
          parsed.source_vendor,
          sourceAdapter,
          parsed.timestamp
        );
      }
  }
}

function readIncrementalCursor(db: EventProjectorDatabase): EventLogCursor | null {
  const row = db
    .prepare<{
      fileIdentity: string | null;
      committedOffset: number;
      committedPrefixHash: string | null;
    }>(
      `
        SELECT file_identity AS fileIdentity, offset_bytes AS committedOffset,
               committed_prefix_hash AS committedPrefixHash
        FROM ingestion_state WHERE stream_name = 'events.jsonl'
      `
    )
    .get();
  if (
    !row ||
    typeof row.fileIdentity !== "string" ||
    row.fileIdentity.length === 0 ||
    !Number.isSafeInteger(row.committedOffset) ||
    row.committedOffset < 0 ||
    typeof row.committedPrefixHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.committedPrefixHash)
  ) {
    return null;
  }
  return {
    fileIdentity: row.fileIdentity,
    committedOffset: row.committedOffset,
    committedPrefixHash: row.committedPrefixHash
  };
}

function writeIncrementalCursor(
  db: EventProjectorDatabase,
  cursor: EventLogCursor,
  signature: EventLogSignature
): void {
  db.prepare(
    `
      INSERT INTO ingestion_state (
        stream_name, offset_bytes, size_bytes, mtime_ms, file_identity, committed_prefix_hash
      ) VALUES ('events.jsonl', ?, ?, ?, ?, ?)
      ON CONFLICT(stream_name) DO UPDATE SET
        offset_bytes = excluded.offset_bytes,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        file_identity = excluded.file_identity,
        committed_prefix_hash = excluded.committed_prefix_hash
    `
  ).run(
    cursor.committedOffset,
    signature.size,
    signature.mtimeMs,
    cursor.fileIdentity,
    cursor.committedPrefixHash
  );
}

export async function readEventLogSignature(eventLogPath: string): Promise<EventLogSignature | null> {
  try {
    const details = await stat(eventLogPath);
    return { mtimeMs: details.mtimeMs, size: details.size };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * After Phase-2 legacy backfill, ingestion_state may keep an offset without file identity /
 * prefix hash. That makes readIncrementalCursor() return null and forces a full 100MB+ replay.
 * Repair by materializing a real cursor at the stored offset (clamped to file size).
 */
export async function repairBrokenIngestionCursor(input: {
  db: EventProjectorDatabase;
  eventLogPath: string;
}): Promise<{ repaired: boolean; committedOffset: number }> {
  const signature = await readEventLogSignature(input.eventLogPath);
  if (signature === null) {
    return { repaired: false, committedOffset: 0 };
  }

  const existing = readIncrementalCursor(input.db);
  if (existing !== null) {
    return { repaired: false, committedOffset: existing.committedOffset };
  }

  const row = input.db
    .prepare<{ offsetBytes: number }>(
      `SELECT offset_bytes AS offsetBytes FROM ingestion_state WHERE stream_name = 'events.jsonl'`
    )
    .get();
  const rawOffset =
    row && Number.isSafeInteger(row.offsetBytes) && row.offsetBytes >= 0 ? row.offsetBytes : signature.size;
  const committedOffset = Math.min(rawOffset, signature.size);
  const cursor = await createEventLogCursor(input.eventLogPath, committedOffset);
  writeIncrementalCursor(input.db, cursor, signature);
  return { repaired: true, committedOffset };
}

export async function withCanonicalWriterLease<T>(input: {
  lockPath: string;
  canonicalPath: string;
  signal: AbortSignal;
  operation: () => Promise<T>;
}): Promise<T> {
  let lease = await acquireCanonicalLease({ lockPath: input.lockPath, canonicalPath: input.canonicalPath });
  while (lease === false) {
    if (input.signal.aborted) {
      throw new Error("sync aborted while waiting for the canonical writer lease");
    }
    await waitForLeaseRetry(input.signal);
    lease = await acquireCanonicalLease({ lockPath: input.lockPath, canonicalPath: input.canonicalPath });
  }
  try {
    return await input.operation();
  } finally {
    await releaseCanonicalLease(lease);
  }
}

function toolCallIdForLegacyStorage(
  event: Extract<AnyEvent, { type: "tool.called" | "tool.succeeded" | "tool.failed" }>
): string | null {
  if ("tool_call_id" in event && typeof event.tool_call_id === "string" && event.tool_call_id.length > 0) {
    return event.tool_call_id;
  }
  return null;
}

function normalizeSourceAdapterForStorage(event: AnyEvent): string {
  if (event.source_adapter !== "claude") {
    return event.source_adapter;
  }
  if (event.type === "prompt.submitted" || event.type === "assistant.responded" || event.type === "token.usage.recorded") {
    return "claude-transcript";
  }
  return "claude-hook";
}

function parsedSourceVendor(value: unknown): SourceVendor | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const parsed = SourceVendorSchema.safeParse((value as Record<string, unknown>).source_vendor);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

function sourceInstanceIdForVendor(sourceVendor: SourceVendor | null): string {
  if (sourceVendor === "claude-code") return "claude:default";
  if (sourceVendor === "opencode") return "opencode:default";
  if (sourceVendor === "zcode") return "zcode:default";
  if (sourceVendor === "kimicode") return "kimicode:default";
  if (sourceVendor === "dsh") return "dsh:default";
  if (sourceVendor === "codex") return "codex:default";
  if (sourceVendor === "cursor") return "cursor:default";
  if (sourceVendor === "mimo") return "mimo:default";
  return "unknown:default";
}

function sourceRecordIdForNormalization(event: AnyEvent): string | null {
  if (event.type === "tool.called" || event.type === "tool.succeeded" || event.type === "tool.failed") {
    const toolCallId = "tool_call_id" in event && typeof event.tool_call_id === "string" ? event.tool_call_id : null;
    return toolCallId?.startsWith("native:") ? toolCallId.slice("native:".length) : null;
  }
  if (event.type === "prompt.submitted") return event.prompt_id;
  if (event.type === "assistant.responded") return event.message_id;
  if (event.type === "token.usage.recorded") return event.message_id;
  return event.event_id;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function waitForLeaseRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 25);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("sync aborted while waiting for the canonical writer lease"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isSameEventLogSignature(left: EventLogSignature | null, right: EventLogSignature | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}
