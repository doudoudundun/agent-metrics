import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { AnyEventSchema, normalizeModelId, type NormalizedEventV2 } from "@agent-metrics/event-schema";
import {
  appendJsonLine,
  loadEventLedgerWithFallback,
  persistEventLedger,
  readJsonlLines,
  reconcileLedgerSessionsWithEventLog
} from "@agent-metrics/shared-utils";
import {
  createCodexRolloutParser,
  type CodexParserState,
  type CodexProviderConfig
} from "./codex.js";
import {
  collectCodexTurnInputMetadata,
  type CodexTurnInputMetadata,
  type CodexTurnInputLogRow
} from "./turn-metadata.js";

/** Re-check rollouts under this many days so ledger/jsonl drift self-heals. */
const RECENT_ROLLOUT_RECONCILE_DAYS = 4;
const CODEX_TURN_INPUT_LOG_TAIL_LIMIT = 5_000;
const CODEX_TURN_INPUT_LOG_SESSION_SCAN_LIMIT = 5_000;
const CODEX_TURN_INPUT_LOG_SESSION_MATCH_LIMIT = 500;

type RolloutFileSignature = {
  size: number;
  mtimeMs: number;
  ino?: number;
  /** Byte offset after the last fully consumed JSONL record. */
  offset?: number;
  /** False while a rollout still has unread bytes; the next run resumes. */
  caughtUp?: boolean;
  parserState?: CodexParserState;
};

type SyncCursor = {
  rolloutFiles: Record<string, RolloutFileSignature>;
  logsLastId: number;
  sessionModels: Record<string, string>;
};


type CodexLogRow = {
  id: number;
  feedback_log_body: string | null;
};

type ReadOnlyDatabase = {
  close(): void;
  prepare<Result = unknown>(sql: string): {
    all(...params: unknown[]): Result[];
  };
};

export function resolveDefaultCodexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

export function resolveDefaultCodexMulticaSessionsRoot(): string {
  return join(homedir(), ".codex", "multica-sessions");
}

/**
 * any-subagent managed Codex conversations run with a per-conversation
 * CODEX_HOME (<state>/conversations/<id>/provider/codex-home), so their rollouts
 * never land under ~/.codex/sessions. Discover each isolated sessions root.
 */
export function resolveDefaultAnySubagentSessionsRoots(): string[] {
  const stateHome =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  const conversationsRoot = join(stateHome, "any-subagent", "conversations");
  if (!existsSync(toFsPath(conversationsRoot))) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(toFsPath(conversationsRoot), { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessions = join(conversationsRoot, entry.name, "provider", "codex-home", "sessions");
    if (existsSync(toFsPath(sessions))) {
      roots.push(sessions);
    }
  }
  return roots.sort();
}

export function resolveDefaultCodexSessionsRoots(): string[] {
  return [
    resolveDefaultCodexSessionsRoot(),
    resolveDefaultCodexMulticaSessionsRoot(),
    ...resolveDefaultAnySubagentSessionsRoots()
  ];
}

export function resolveDefaultCodexLogsDbPath(): string {
  return join(homedir(), ".codex", "logs_2.sqlite");
}

export function resolveDefaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

export function resolveCodexSessionsRoots(input: {
  sessionsRoot?: string;
  sessionsRoots?: string[];
} = {}): string[] {
  if (input.sessionsRoots && input.sessionsRoots.length > 0) {
    return [...new Set(input.sessionsRoots)];
  }

  if (input.sessionsRoot) {
    return [input.sessionsRoot];
  }

  const singleRoot = process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT?.trim();
  if (singleRoot) {
    return [singleRoot];
  }

  const multiRoots = process.env.AGENT_METRICS_CODEX_SESSIONS_ROOTS?.trim();
  if (multiRoots) {
    return [
      ...new Set(
        multiRoots
          .split(/[;|]/u)
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      )
    ];
  }

  return resolveDefaultCodexSessionsRoots();
}

export function resolveCodexSourcePaths(input: {
  sessionsRoot?: string;
  sessionsRoots?: string[];
  logsDbPath?: string;
  configPath?: string;
} = {}): {
  sessionsRoot: string;
  sessionsRoots: string[];
  logsDbPath: string;
  configPath: string;
} {
  const sessionsRoots = resolveCodexSessionsRoots(input);
  return {
    sessionsRoot: sessionsRoots[0] ?? resolveDefaultCodexSessionsRoot(),
    sessionsRoots,
    logsDbPath:
      input.logsDbPath ??
      process.env.AGENT_METRICS_CODEX_LOGS_DB_PATH ??
      resolveDefaultCodexLogsDbPath(),
    configPath:
      input.configPath ??
      process.env.AGENT_METRICS_CODEX_CONFIG_PATH ??
      resolveDefaultCodexConfigPath()
  };
}

/**
 * Windows paths under Multica can exceed MAX_PATH; Node fs needs the \\?\ prefix.
 * Keep logical (unprefixed) paths in cursor/ledger keys for stability.
 */
export function toFsPath(filePath: string): string {
  if (process.platform !== "win32") {
    return filePath;
  }
  if (filePath.startsWith("\\\\?\\")) {
    return filePath;
  }
  if (filePath.startsWith("\\\\")) {
    return `\\\\?\\UNC\\${filePath.slice(2)}`;
  }
  return `\\\\?\\${filePath}`;
}

export function isMulticaSessionsPath(filePath: string): boolean {
  return /(?:^|[/\\])multica-sessions(?:[/\\]|$)/iu.test(filePath);
}

export function isAnySubagentSessionsPath(filePath: string): boolean {
  return /(?:^|[/\\])provider[/\\]codex-home[/\\]sessions(?:[/\\]|$)/iu.test(filePath);
}

export async function syncCodexRollouts(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  sessionsRoot?: string;
  sessionsRoots?: string[];
  logsDbPath?: string;
  configPath?: string;
  /**
   * When true (default), re-check recent rollouts against events.jsonl to heal
   * ledger/cursor drift. Lightweight refresh passes false and only processes
   * files whose size/mtime changed.
   */
  reconcileRecent?: boolean;
  /** Byte budget per rollout file per run (default 8 MiB). */
  maxBytesPerFile?: number;
  /** Total byte budget per run across all rollouts (default 64 MiB). */
  maxBytesPerSync?: number;
}): Promise<void> {
  const { sessionsRoots, logsDbPath, configPath } = resolveCodexSourcePaths(input);
  const existingRoots = sessionsRoots.filter((root) => existsSync(toFsPath(root)));
  if (existingRoots.length === 0) {
    return;
  }

  let bytesReadTotal = 0;

  const reconcileRecent = input.reconcileRecent !== false;
  const cursor = await loadCursor(input.cursorPath);
  const seenEventIds = await loadEventLedgerWithFallback({
    ledgerPath: input.ledgerPath,
    eventLogPath: input.eventLogPath,
    prefix: "codex:"
  });
  const baselineEventCount = seenEventIds.size;

  const providerConfigs = await loadProviderConfigs(configPath);
  const { sessionModels, logsLastId } = loadSessionModelsFromLogs({
    logsDbPath,
    previousModels: cursor.sessionModels,
    previousLastId: cursor.logsLastId
  });
  const rolloutFiles = (
    await Promise.all(existingRoots.map((root) => collectRolloutFiles(root)))
  )
    .flat()
    .sort();
  const nextRolloutFiles: Record<string, RolloutFileSignature> = {
    ...cursor.rolloutFiles
  };
  let ledgerChanged = seenEventIds.size !== baselineEventCount;

  // Recent rollouts: trust events.jsonl over ledger, and drop cursor so files
  // are re-read when ledger claimed "seen" but rows never landed in the log.
  // Reconciling needs evidence from the event log; when none exists yet there
  // is nothing to heal and a scan would fail on the missing file.
  if (reconcileRecent && existsSync(input.eventLogPath)) {
    const recentSessionIds = new Set<string>();
    let recentCursorHit = false;
    for (const filePath of rolloutFiles) {
      if (!isRecentRolloutPath(filePath)) {
        continue;
      }
      const sessionId = sessionIdFromRolloutPath(filePath);
      if (sessionId === null) {
        continue;
      }
      recentSessionIds.add(sessionId);
      if (nextRolloutFiles[filePath] !== undefined) {
        recentCursorHit = true;
      }
    }

    if (recentSessionIds.size > 0 && recentCursorHit) {
      const reconciled = await reconcileLedgerSessionsWithEventLog({
        eventLogPath: input.eventLogPath,
        prefix: "codex:",
        seenEventIds,
        sessionIds: recentSessionIds,
        sessionIdFromKey: sessionIdFromCodexLedgerKey
      });
      if (reconciled.removed > 0 || reconciled.added > 0) {
        ledgerChanged = true;
      }
      if (reconciled.removed > 0) {
        for (const path of Object.keys(nextRolloutFiles)) {
          const sessionId = sessionIdFromRolloutPath(path);
          if (sessionId !== null && recentSessionIds.has(sessionId)) {
            delete nextRolloutFiles[path];
          }
        }
      }
    }
  }

  const commitEvent = async (event: NormalizedEventV2): Promise<void> => {
    // The parser already emits NormalizedEventV2; source_record_id carries the
    // stable pre-conversion legacy event_id that the ledger has always keyed on.
    const ledgerKey = ledgerKeyFor(event);
    if (seenEventIds.has(ledgerKey)) {
      return;
    }

    await appendJsonLine(input.eventLogPath, event);
    seenEventIds.add(ledgerKey);
    ledgerChanged = true;
  };

  const candidates = (
    await Promise.all(
      rolloutFiles.map(async (filePath) => {
        try {
          return { filePath, signature: await readFileSignature(filePath) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }
      })
    )
  ).filter((candidate): candidate is { filePath: string; signature: RolloutFileSignature } => {
    return candidate !== null;
  });
  // Newer sessions get a turn first so bounded catch-up of huge historical
  // rollouts can never starve active sessions.
  candidates.sort((left, right) => right.signature.mtimeMs - left.signature.mtimeMs);

  const perFileBudget = input.maxBytesPerFile ?? 8 * 1024 * 1024;
  const syncBudget = input.maxBytesPerSync ?? 64 * 1024 * 1024;
  const turnInputMetadataBySession = new Map<
    string,
    ReadonlyMap<string, CodexTurnInputMetadata>
  >();
  let globalTurnInputMetadata: ReadonlyMap<string, CodexTurnInputMetadata> | undefined;

  for (const { filePath, signature } of candidates) {
    const previous = nextRolloutFiles[filePath];
    if (isSameRolloutSignature(signature, previous) && previous?.caughtUp === true) {
      continue;
    }
    if (bytesReadTotal >= syncBudget) {
      continue;
    }

    // Resume only when the checkpointed parser state provably belongs to the
    // same file revision: same inode, offset still inside the file, and the
    // file appended (or is untouched) rather than rewritten.
    let start = 0;
    let resumeState: CodexParserState | undefined;
    if (
      previous &&
      previous.parserState !== undefined &&
      previous.parserState.turnId !== undefined &&
      // Old checkpoints did not retain thread_settings_applied. Replay once
      // on the next change so appended records inherit the correct tier.
      previous.parserState.threadServiceTier !== undefined &&
      // Older checkpoints cannot tell whether earlier token_count records
      // already disabled mirror fallback. Replay once before resuming them.
      previous.parserState.tokenCountUsageSeen !== undefined &&
      previous.offset !== undefined &&
      previous.ino !== undefined &&
      previous.ino === signature.ino &&
      previous.offset <= signature.size &&
      (signature.size > previous.size || signature.mtimeMs === previous.mtimeMs)
    ) {
      start = previous.offset;
      resumeState = previous.parserState;
    }

    try {
      const pathSessionId = sessionIdFromRolloutPath(filePath);
      const checkpointSessionId =
        resumeState?.childUsageMeta?.sessionId ?? resumeState?.sessionMeta?.sessionId ?? null;
      const metadataSessionId =
        pathSessionId !== null && checkpointSessionId !== null && pathSessionId !== checkpointSessionId
          ? null
          : pathSessionId ?? checkpointSessionId;
      let turnInputMetadata: ReadonlyMap<string, CodexTurnInputMetadata>;
      if (metadataSessionId !== null) {
        turnInputMetadata = turnInputMetadataBySession.get(metadataSessionId) ??
          await loadCodexTurnInputMetadata(logsDbPath, metadataSessionId);
        turnInputMetadataBySession.set(metadataSessionId, turnInputMetadata);
      } else {
        globalTurnInputMetadata ??= await loadCodexTurnInputMetadata(logsDbPath);
        turnInputMetadata = globalTurnInputMetadata;
      }

      const parser = createCodexRolloutParser(
        {
          filePath,
          sessionModels,
          providerConfigs,
          turnInputMetadata,
          sourceInstanceId: isMulticaSessionsPath(filePath)
            ? "codex:multica"
            : isAnySubagentSessionsPath(filePath)
              ? "codex:any-subagent"
              : undefined
        },
        resumeState
      );
      let offset = start;
      let budgetExhausted = false;
      let unterminatedTailState: CodexParserState | undefined;
      // A batch may exceed its budget by one record so complete records are
      // never split or dropped.
      const budget = Math.min(perFileBudget, syncBudget - bytesReadTotal);

      for await (const entry of readJsonlLines({
        filePath: toFsPath(filePath),
        start,
        end: signature.size,
        includeUnterminated: true
      })) {
        // Never checkpoint a partial record: its bytes are re-read once the
        // record completes, and must reparse with the same context.
        if (!entry.complete) {
          unterminatedTailState = parser.checkpoint();
        }
        const events = parser.parseLines([entry.line.replace(/\r$/u, "")]);
        for (const event of events) {
          await commitEvent(event);
        }
        if (entry.complete) {
          offset = entry.nextOffset;
        }
        if (entry.nextOffset - start >= budget) {
          budgetExhausted = true;
          break;
        }
      }

      const caughtUp = !budgetExhausted;
      if (caughtUp) {
        // Emit the buffered same-timestamp tail group. For an unterminated
        // final record this publishes what already parsed cleanly, while the
        // persisted state stays at the last complete record so those bytes are
        // re-read (and deduped via the ledger) once the record completes.
        for (const event of parser.flush()) {
          await commitEvent(event);
        }
      }

      bytesReadTotal += (caughtUp ? signature.size : offset) - start;
      // Only advance the cursor after this run's events were appended (or
      // skipped as already present). Avoids the cursor running past a crashed
      // mid-file write.
      nextRolloutFiles[filePath] = {
        ...signature,
        offset,
        caughtUp,
        parserState: unterminatedTailState ?? parser.checkpoint()
      };
    } catch (error) {
      // One corrupt/legacy rollout must not fail the whole Codex adapter run.
      // Oversized JSONL records surface here as a redacted
      // JSONL_LINE_TOO_LARGE error; the source file is left untouched.
      console.error(
        `[codex-sync] skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
  }

  const nextCursor = {
    rolloutFiles: nextRolloutFiles,
    logsLastId,
    sessionModels
  } satisfies SyncCursor;

  if (!isSameCursor(nextCursor, cursor)) {
    await writeJsonFileAtomic(input.cursorPath, nextCursor);
  }

  if (ledgerChanged) {
    await persistEventLedger(input.ledgerPath, seenEventIds);
  }
}

function loadSessionModelsFromLogs(input: {
  logsDbPath: string;
  previousModels: Record<string, string>;
  previousLastId: number;
}): {
  sessionModels: Record<string, string>;
  logsLastId: number;
} {
  if (!existsSync(toFsPath(input.logsDbPath))) {
    return {
      sessionModels: { ...input.previousModels },
      logsLastId: input.previousLastId
    };
  }

  const db = new Database(toFsPath(input.logsDbPath), {
    readonly: true,
    fileMustExist: true
  }) as ReadOnlyDatabase;

  try {
    const rows = db
      .prepare<CodexLogRow>(
        `
          SELECT id, feedback_log_body
          FROM logs
          WHERE id > ?
            AND feedback_log_body IS NOT NULL
            AND feedback_log_body LIKE '%model=%'
            AND (
              feedback_log_body LIKE '%conversation.id=%'
              OR feedback_log_body LIKE '%thread.id=%'
            )
          ORDER BY id ASC
        `
      )
      .all(input.previousLastId);
    const sessionModels = {
      ...input.previousModels
    };
    let logsLastId = input.previousLastId;

    for (const row of rows) {
      logsLastId = row.id > logsLastId ? row.id : logsLastId;

      if (typeof row.feedback_log_body !== "string") {
        continue;
      }

      const match = /(?:conversation\.id|thread\.id)=([0-9a-f-]+).*?\bmodel=([^\s";]+)/iu.exec(
        row.feedback_log_body
      );
      if (!match) {
        continue;
      }

      const model = normalizeModelId(match[2]);
      if (model) {
        sessionModels[match[1]] = model;
      }
    }

    return {
      sessionModels,
      logsLastId
    };
  } finally {
    db.close();
  }
}

export async function loadCodexTurnInputMetadata(
  logsDbPath: string,
  sessionId?: string
): Promise<ReadonlyMap<string, CodexTurnInputMetadata>> {
  if (!existsSync(toFsPath(logsDbPath))) {
    return new Map();
  }

  let db: ReadOnlyDatabase | null = null;

  try {
    db = new Database(toFsPath(logsDbPath), {
      readonly: true,
      fileMustExist: true
    }) as ReadOnlyDatabase;
    // Prefer the indexed session lookup for rollouts being parsed. It survives
    // unrelated sessions pushing their logs beyond the global tail. Limit raw
    // rows before filtering so even a very active session has a bounded scan.
    // Unknown rollout IDs retain the bounded global-tail fallback.
    const rows = sessionId
      ? db
          .prepare<CodexTurnInputLogRow>(
            `
              SELECT target, thread_id, feedback_log_body
              FROM (
                SELECT id, target, thread_id, feedback_log_body
                FROM logs
                WHERE thread_id = ?
                ORDER BY id DESC
                LIMIT ?
              )
              WHERE target = 'feedback_tags'
                AND feedback_log_body IS NOT NULL
                AND length(CAST(feedback_log_body AS BLOB)) <= 65536
                AND (
                  feedback_log_body LIKE '%op.dispatch.turn_input%'
                  OR feedback_log_body LIKE '%op.dispatch.inter_agent_communication%'
                )
              ORDER BY id DESC
              LIMIT ?
            `
          )
          .all(
            sessionId,
            CODEX_TURN_INPUT_LOG_SESSION_SCAN_LIMIT,
            CODEX_TURN_INPUT_LOG_SESSION_MATCH_LIMIT
          )
      : db
          .prepare<CodexTurnInputLogRow>(
            `
              SELECT target, thread_id, feedback_log_body
              FROM (
                SELECT id, target, thread_id, feedback_log_body
                FROM logs
                ORDER BY id DESC
                LIMIT ?
              )
              WHERE target = 'feedback_tags'
                AND feedback_log_body IS NOT NULL
                AND length(CAST(feedback_log_body AS BLOB)) <= 65536
                AND (
                  feedback_log_body LIKE '%op.dispatch.turn_input%'
                  OR feedback_log_body LIKE '%op.dispatch.inter_agent_communication%'
                )
              ORDER BY id DESC
            `
          )
          .all(CODEX_TURN_INPUT_LOG_TAIL_LIMIT);

    return collectCodexTurnInputMetadata(rows);
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
}

async function loadProviderConfigs(configPath: string): Promise<Record<string, CodexProviderConfig>> {
  if (!existsSync(toFsPath(configPath))) {
    return {};
  }

  const contents = await readFile(toFsPath(configPath), "utf8");
  const lines = contents.split(/\r?\n/u);
  const providerConfigs: Record<string, CodexProviderConfig> = {};
  let activeProviderId: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sectionMatch = /^\[model_providers\.([^\]]+)\]$/u.exec(line);

    if (sectionMatch) {
      activeProviderId = sectionMatch[1].replace(/^['"]|['"]$/gu, "");
      if (!providerConfigs[activeProviderId]) {
        providerConfigs[activeProviderId] = {
          baseUrl: null,
          host: null
        };
      }
      continue;
    }

    if (!activeProviderId) {
      continue;
    }

    const baseUrlMatch = /^base_url\s*=\s*"([^"]+)"$/u.exec(line);
    if (!baseUrlMatch) {
      continue;
    }

    const baseUrl = baseUrlMatch[1];
    providerConfigs[activeProviderId] = {
      baseUrl,
      host: extractHost(baseUrl)
    };
  }

  return providerConfigs;
}

async function collectRolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(toFsPath(root), { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectRolloutFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

async function readFileSignature(filePath: string): Promise<RolloutFileSignature> {
  const details = await stat(toFsPath(filePath));
  return {
    size: details.size,
    mtimeMs: details.mtimeMs,
    ino: details.ino
  };
}

function isSameRolloutSignature(
  left: RolloutFileSignature,
  right: RolloutFileSignature | undefined
): boolean {
  return (
    !!right &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    (right.ino === undefined || left.ino === right.ino)
  );
}

async function loadCursor(cursorPath: string): Promise<SyncCursor> {
  const parsed = await readJsonFile(cursorPath);

  if (
    !parsed ||
    !isRecord(parsed)
  ) {
    return createEmptyCursor();
  }

  return {
    rolloutFiles: parseRolloutFiles(parsed.rolloutFiles),
    logsLastId:
      typeof parsed.logsLastId === "number" && Number.isInteger(parsed.logsLastId) && parsed.logsLastId >= 0
        ? parsed.logsLastId
        : 0,
    sessionModels: parseSessionModels(parsed.sessionModels)
  };
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(toFsPath(filePath), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
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

function createEmptyCursor(): SyncCursor {
  return {
    rolloutFiles: {},
    logsLastId: 0,
    sessionModels: {}
  };
}

function parseRolloutFiles(value: unknown): Record<string, RolloutFileSignature> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value).flatMap(([filePath, signature]) => {
    if (!isRecord(signature)) {
      return [];
    }

    const size =
      typeof signature.size === "number" && Number.isInteger(signature.size) && signature.size >= 0
        ? signature.size
        : null;
    const mtimeMs =
      typeof signature.mtimeMs === "number" && signature.mtimeMs >= 0 ? signature.mtimeMs : null;

    if (size === null || mtimeMs === null) {
      return [];
    }

    // Legacy entries ({size, mtimeMs} only, from before byte checkpoints)
    // stay readable but count as not caught up, so their file is re-read from
    // byte 0 once instead of being skipped forever.
    const offset =
      typeof signature.offset === "number" &&
      Number.isSafeInteger(signature.offset) &&
      signature.offset >= 0 &&
      signature.offset <= size
        ? signature.offset
        : undefined;
    const parserState = isValidParserState(signature.parserState)
      ? signature.parserState
      : undefined;

    return [
      [
        filePath,
        {
          size,
          mtimeMs,
          ino: typeof signature.ino === "number" ? signature.ino : undefined,
          offset,
          caughtUp: signature.caughtUp === true,
          parserState
        }
      ] as const
    ];
  });

  return Object.fromEntries(entries);
}

function isValidParserState(value: unknown): value is CodexParserState {
  if (!isRecord(value)) {
    return false;
  }

  if (!Number.isSafeInteger(value.lineIndex) || (value.lineIndex as number) < 0) {
    return false;
  }

  if (value.sourceInstanceId !== null && value.sourceInstanceId !== undefined &&
    typeof value.sourceInstanceId !== "string") {
    return false;
  }

  // New turn-scoped metadata is optional so checkpoints written before this
  // parser version remain readable.
  if (
    (value.turnId !== undefined && value.turnId !== null && typeof value.turnId !== "string") ||
    (value.turnModel !== undefined && value.turnModel !== null && typeof value.turnModel !== "string") ||
    (value.turnServiceTier !== undefined &&
      value.turnServiceTier !== null &&
      typeof value.turnServiceTier !== "string") ||
    (value.threadServiceTier !== undefined &&
      value.threadServiceTier !== null &&
      typeof value.threadServiceTier !== "string")
  ) {
    return false;
  }

  if (
    value.sessionMeta !== null &&
    value.sessionMeta !== undefined &&
    !isValidSessionMetadata(value.sessionMeta)
  ) {
    return false;
  }

  if (
    value.childUsageMeta !== null &&
    value.childUsageMeta !== undefined &&
    !isValidSessionMetadata(value.childUsageMeta)
  ) {
    return false;
  }

  if (
    !Array.isArray(value.pendingToolCalls) ||
    !value.pendingToolCalls.every(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        isRecord(entry[1]) &&
        ["sessionId", "workspacePath", "timestamp", "toolName", "argumentSummary"].every(
          (key) => typeof entry[1][key] === "string"
        )
    )
  ) {
    return false;
  }

  if (
    !Array.isArray(value.pendingEvents) ||
    !value.pendingEvents.every((event) => isRecord(event) && AnyEventSchema.safeParse(event).success)
  ) {
    return false;
  }

  if (value.tokenCountUsageSeen !== undefined && typeof value.tokenCountUsageSeen !== "boolean") {
    return false;
  }
  if (
    value.pendingMirror !== undefined &&
    value.pendingMirror !== null &&
    (!isRecord(value.pendingMirror) ||
      value.pendingMirror.type !== "token.usage.recorded" ||
      !AnyEventSchema.safeParse(value.pendingMirror).success)
  ) {
    return false;
  }
  if (
    value.previousTotalTokens !== undefined &&
    value.previousTotalTokens !== null &&
    (!Number.isSafeInteger(value.previousTotalTokens) || (value.previousTotalTokens as number) < 0)
  ) {
    return false;
  }
  for (const key of ["mirroredUsageEvents", "mirroredUsageDeferredEvents"]) {
    const events = value[key];
    if (events !== undefined &&
      (!Array.isArray(events) || !events.every((event) => AnyEventSchema.safeParse(event).success))) {
      return false;
    }
  }

  return true;
}

function isValidSessionMetadata(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.workspacePath === "string" &&
    (value.providerId === null || typeof value.providerId === "string")
  );
}

function parseSessionModels(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([sessionId, rawModel]) => {
      const model = typeof rawModel === "string" ? normalizeModelId(rawModel) : null;
      return model ? [[sessionId, model]] : [];
    })
  );
}

function isSameCursor(left: SyncCursor, right: SyncCursor): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extractHost(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ledgerKeyFor(event: NormalizedEventV2): string {
  return event.source_record_id ?? event.event_id;
}

function sessionIdFromRolloutPath(filePath: string): string | null {
  const match = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
  );
  return match?.[1] ?? null;
}

function sessionIdFromCodexLedgerKey(ledgerKey: string): string | null {
  const match = ledgerKey.match(
    /^codex:session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i
  );
  return match?.[1] ?? null;
}

function isRecentRolloutPath(filePath: string, nowMs = Date.now()): boolean {
  const match = filePath.match(/[/\\](\d{4})[/\\](\d{2})[/\\](\d{2})[/\\]/);
  if (!match) {
    return true;
  }

  const fileDayMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return nowMs - fileDayMs < RECENT_ROLLOUT_RECONCILE_DAYS * 24 * 60 * 60 * 1000;
}
