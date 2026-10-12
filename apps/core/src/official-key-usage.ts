import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { KeyUsageEntry, KeyUsageResponse } from "@agent-metrics/contracts";
import type { SqliteDatabaseLike } from "./domain-types.js";

/**
 * Official key quota snapshots harvested from provider artifacts. Codex is the
 * first vendor: rollout logs carry `rate_limits` on every `token_count` event,
 * so quota state is readable locally without any network call.
 *
 * The parser is intentionally self-contained instead of importing the Codex
 * adapter: quota harvesting and event normalization evolve independently.
 */

export const CODEX_KEY_USAGE_VENDOR = "codex";
export const CODEX_KEY_USAGE_SOURCE = "codex-rollout";

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 6;
const RATE_LIMITS_MARKER = '"rate_limits"';

export type OfficialKeyUsageWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string | null;
};

export type OfficialKeyUsageCredits = {
  hasCredits: boolean;
  unlimited: boolean;
};

export type OfficialKeyUsageSnapshot = {
  vendor: string;
  source: string;
  limitId: string | null;
  limitName: string | null;
  primary: OfficialKeyUsageWindow | null;
  secondary: OfficialKeyUsageWindow | null;
  credits: OfficialKeyUsageCredits | null;
  /** Plan/key expiry (ISO) when the source reports one; null for Codex rollouts. */
  expiresAt: string | null;
  /** When the source record was written (ISO), or the file mtime as fallback. */
  observedAt: string;
};

export type CollectCodexKeyUsageOptions = {
  sessionsRoot?: string;
  vendor?: string;
  source?: string;
  now?: () => Date;
  lookbackMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  log?: { warn: (message: string) => void };
};

export type CollectCodexKeyUsageResult = {
  filesScanned: number;
  recordsRead: number;
  snapshotsFound: number;
  snapshotsStored: number;
};

type RateLimitsFields = {
  limitId: string | null;
  limitName: string | null;
  primary: OfficialKeyUsageWindow | null;
  secondary: OfficialKeyUsageWindow | null;
  credits: OfficialKeyUsageCredits | null;
};

type RolloutFileCandidate = {
  path: string;
  mtimeMs: number;
  size: number;
};

type OfficialKeyUsageDbRow = {
  vendor: string;
  limitKey: string;
  source: string;
  limitId: string | null;
  limitName: string | null;
  primaryUsedPercent: number | null;
  primaryWindowMinutes: number | null;
  primaryResetsAt: string | null;
  secondaryUsedPercent: number | null;
  secondaryWindowMinutes: number | null;
  secondaryResetsAt: string | null;
  creditsHasCredits: number | null;
  creditsUnlimited: number | null;
  expiresAt: string | null;
  observedAt: string;
};

/** `rate_limits` payload → snapshot fields; null when nothing usable is present. */
export function parseRateLimits(value: unknown): RateLimitsFields | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const primary = parseWindow(record.primary);
  const secondary = parseWindow(record.secondary);
  const credits = parseCredits(record.credits);
  if (primary === null && secondary === null && credits === null) {
    return null;
  }

  return {
    limitId: readOptionalString(record.limit_id),
    limitName: readOptionalString(record.limit_name),
    primary,
    secondary,
    credits
  };
}

/**
 * Reads rate-limit snapshots out of rollout JSONL contents. Broken lines and
 * lines without quota data are skipped rather than failing the whole scan.
 */
export function extractSnapshotsFromRolloutText(
  contents: string,
  options: {
    vendor?: string;
    source?: string;
    observedAt?: string;
  } = {}
): OfficialKeyUsageSnapshot[] {
  const vendor = options.vendor ?? CODEX_KEY_USAGE_VENDOR;
  const source = options.source ?? CODEX_KEY_USAGE_SOURCE;
  const fallbackObservedAt = options.observedAt ?? new Date(0).toISOString();
  const snapshots: OfficialKeyUsageSnapshot[] = [];

  for (const line of contents.split(/\r?\n/u)) {
    const snapshot = parseRolloutLine(line, { vendor, source, fallbackObservedAt });
    if (snapshot !== null) {
      snapshots.push(snapshot);
    }
  }

  return snapshots;
}

/**
 * One turn emits many `token_count` events that share a quota window. Keeping
 * the newest snapshot per (vendor, limit, primary reset, secondary reset) drops
 * those repeats while preserving each distinct window change.
 */
export function dedupeSnapshots(snapshots: OfficialKeyUsageSnapshot[]): OfficialKeyUsageSnapshot[] {
  const latest = new Map<string, OfficialKeyUsageSnapshot>();
  for (const snapshot of snapshots) {
    const key = snapshotGroupKey(snapshot);
    const existing = latest.get(key);
    if (existing === undefined || snapshot.observedAt >= existing.observedAt) {
      latest.set(key, snapshot);
    }
  }

  return [...latest.values()].sort(compareSnapshots);
}

export function ensureOfficialKeyUsageSchema(db: SqliteDatabaseLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS official_key_usage (
      vendor TEXT NOT NULL,
      limit_key TEXT NOT NULL,
      window_key TEXT NOT NULL,
      source TEXT NOT NULL,
      limit_id TEXT,
      limit_name TEXT,
      primary_used_percent REAL,
      primary_window_minutes INTEGER,
      primary_resets_at TEXT,
      secondary_used_percent REAL,
      secondary_window_minutes INTEGER,
      secondary_resets_at TEXT,
      credits_has_credits INTEGER,
      credits_unlimited INTEGER,
      expires_at TEXT,
      observed_at TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      PRIMARY KEY (vendor, limit_key, window_key)
    );
    CREATE INDEX IF NOT EXISTS idx_official_key_usage_vendor_observed_at
      ON official_key_usage (vendor, observed_at);
  `);
  const columns = db
    .prepare<{ name: string }>("PRAGMA table_info(official_key_usage)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("expires_at")) {
    db.exec("ALTER TABLE official_key_usage ADD COLUMN expires_at TEXT");
  }
}

/** Upserts snapshots; an older scan never overwrites a newer stored row. */
export function persistOfficialKeyUsage(
  db: SqliteDatabaseLike,
  snapshots: OfficialKeyUsageSnapshot[],
  collectedAt: string = new Date().toISOString()
): number {
  if (snapshots.length === 0) {
    return 0;
  }
  ensureOfficialKeyUsageSchema(db);

  const insert = db.prepare(
    `INSERT INTO official_key_usage (
      vendor, limit_key, window_key, source, limit_id, limit_name,
      primary_used_percent, primary_window_minutes, primary_resets_at,
      secondary_used_percent, secondary_window_minutes, secondary_resets_at,
      credits_has_credits, credits_unlimited, expires_at, observed_at, collected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vendor, limit_key, window_key) DO UPDATE SET
      source = excluded.source,
      limit_id = excluded.limit_id,
      limit_name = excluded.limit_name,
      primary_used_percent = excluded.primary_used_percent,
      primary_window_minutes = excluded.primary_window_minutes,
      primary_resets_at = excluded.primary_resets_at,
      secondary_used_percent = excluded.secondary_used_percent,
      secondary_window_minutes = excluded.secondary_window_minutes,
      secondary_resets_at = excluded.secondary_resets_at,
      credits_has_credits = excluded.credits_has_credits,
      credits_unlimited = excluded.credits_unlimited,
      expires_at = excluded.expires_at,
      observed_at = excluded.observed_at,
      collected_at = excluded.collected_at
    WHERE excluded.observed_at >= official_key_usage.observed_at`
  );

  db.transaction(() => {
    for (const snapshot of snapshots) {
      insert.run(
        snapshot.vendor,
        snapshot.limitId ?? "",
        windowKey(snapshot),
        snapshot.source,
        snapshot.limitId,
        snapshot.limitName,
        snapshot.primary?.usedPercent ?? null,
        snapshot.primary?.windowMinutes ?? null,
        snapshot.primary?.resetsAt ?? null,
        snapshot.secondary?.usedPercent ?? null,
        snapshot.secondary?.windowMinutes ?? null,
        snapshot.secondary?.resetsAt ?? null,
        snapshot.credits === null ? null : snapshot.credits.hasCredits ? 1 : 0,
        snapshot.credits === null ? null : snapshot.credits.unlimited ? 1 : 0,
        snapshot.expiresAt,
        snapshot.observedAt,
        collectedAt
      );
    }
  })();

  return snapshots.length;
}

/** Latest stored snapshot per (vendor, limit). Empty table → empty array. */
export function selectOfficialKeyUsage(
  db: SqliteDatabaseLike,
  options: { vendor?: string } = {}
): OfficialKeyUsageSnapshot[] {
  ensureOfficialKeyUsageSchema(db);
  const vendorFilter = options.vendor === undefined ? "" : "WHERE vendor = ?";
  const rows = db
    .prepare<OfficialKeyUsageDbRow>(
      `SELECT
        vendor,
        limit_key AS limitKey,
        source,
        limit_id AS limitId,
        limit_name AS limitName,
        primary_used_percent AS primaryUsedPercent,
        primary_window_minutes AS primaryWindowMinutes,
        primary_resets_at AS primaryResetsAt,
        secondary_used_percent AS secondaryUsedPercent,
        secondary_window_minutes AS secondaryWindowMinutes,
        secondary_resets_at AS secondaryResetsAt,
        credits_has_credits AS creditsHasCredits,
        credits_unlimited AS creditsUnlimited,
        expires_at AS expiresAt,
        observed_at AS observedAt
      FROM official_key_usage
      ${vendorFilter}
      ORDER BY observed_at DESC`
    )
    .all(...(options.vendor === undefined ? [] : [options.vendor]));

  const latest = new Map<string, OfficialKeyUsageSnapshot>();
  for (const row of rows) {
    const key = `${row.vendor}|${row.limitKey}`;
    if (!latest.has(key)) {
      latest.set(key, toSnapshot(row));
    }
  }

  return [...latest.values()].sort(compareSnapshots);
}

export function toKeyUsageResponse(snapshots: OfficialKeyUsageSnapshot[]): KeyUsageResponse {
  const entries: KeyUsageEntry[] = snapshots
    .map((snapshot) => ({
      vendor: snapshot.vendor,
      source: snapshot.source,
      limitId: snapshot.limitId,
      limitName: snapshot.limitName,
      primary: snapshot.primary,
      secondary: snapshot.secondary,
      credits: snapshot.credits,
      expiresAt: snapshot.expiresAt
    }))
    .filter((entry) => hasKeyUsageSignal(entry));

  return {
    updatedAt: snapshots.reduce<string | null>(
      (newest, snapshot) => (newest === null || snapshot.observedAt > newest ? snapshot.observedAt : newest),
      null
    ),
    entries
  };
}

/** Empty shells (no window, no usable credits) carry no information for the panel. */
function hasKeyUsageSignal(entry: KeyUsageEntry): boolean {
  if (entry.primary !== null || entry.secondary !== null) {
    return true;
  }
  return entry.credits !== null && (entry.credits.hasCredits || entry.credits.unlimited);
}

/**
 * Scans Codex rollout logs under `~/.codex/sessions` and upserts the newest
 * quota snapshot per (vendor, limit). Recently written files are scanned first
 * and the total work is bounded, so this is safe inside a refresh loop.
 */
export async function collectCodexKeyUsage(
  db: SqliteDatabaseLike,
  options: CollectCodexKeyUsageOptions = {}
): Promise<CollectCodexKeyUsageResult> {
  const now = options.now ?? (() => new Date());
  const collectedAt = now();
  const vendor = options.vendor ?? CODEX_KEY_USAGE_VENDOR;
  const source = options.source ?? CODEX_KEY_USAGE_SOURCE;
  const sessionsRoot = options.sessionsRoot ?? resolveDefaultSessionsRoot();
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const candidates = await listRolloutFiles(sessionsRoot, {
    sinceMs: collectedAt.getTime() - lookbackMs,
    maxFiles,
    log: options.log
  });

  const snapshots: OfficialKeyUsageSnapshot[] = [];
  let filesScanned = 0;
  let recordsRead = 0;
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (totalBytes >= maxTotalBytes) {
      break;
    }
    totalBytes += candidate.size;
    filesScanned += 1;
    const scanned = await readSnapshotsFromFile(candidate.path, {
      vendor,
      source,
      fallbackObservedAt: new Date(candidate.mtimeMs).toISOString(),
      log: options.log
    });
    recordsRead += scanned.recordsRead;
    snapshots.push(...scanned.snapshots);
  }

  const deduped = dedupeSnapshots(snapshots);
  return {
    filesScanned,
    recordsRead,
    snapshotsFound: snapshots.length,
    snapshotsStored: persistOfficialKeyUsage(db, deduped, collectedAt.toISOString())
  };
}

/** Mirrors the Codex adapter's isolation env var so tests never read the real HOME. */
function resolveDefaultSessionsRoot(): string {
  const fromEnv = process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return join(homedir(), ".codex", "sessions");
}

function parseRolloutLine(
  line: string,
  context: { vendor: string; source: string; fallbackObservedAt: string }
): OfficialKeyUsageSnapshot | null {
  if (line.length === 0 || !line.includes(RATE_LIMITS_MARKER)) {
    return null;
  }
  const record = parseJsonRecord(line);
  if (record === null || record.type !== "event_msg") {
    return null;
  }
  const payload = asRecord(record.payload);
  if (payload === null) {
    return null;
  }
  const fields = parseRateLimits(payload.rate_limits);
  if (fields === null) {
    return null;
  }

  return {
    vendor: context.vendor,
    source: context.source,
    ...fields,
    expiresAt: null,
    observedAt: readTimestamp(record.timestamp) ?? context.fallbackObservedAt
  };
}

async function readSnapshotsFromFile(
  filePath: string,
  context: {
    vendor: string;
    source: string;
    fallbackObservedAt: string;
    log?: { warn: (message: string) => void };
  }
): Promise<{ snapshots: OfficialKeyUsageSnapshot[]; recordsRead: number }> {
  const snapshots: OfficialKeyUsageSnapshot[] = [];
  let recordsRead = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.includes(RATE_LIMITS_MARKER)) {
        continue;
      }
      recordsRead += 1;
      const snapshot = parseRolloutLine(line, context);
      if (snapshot !== null) {
        snapshots.push(snapshot);
      }
    }
  } catch (error) {
    context.log?.warn(
      `official key usage scan failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    lines.close();
    stream.destroy();
  }

  return { snapshots, recordsRead };
}

async function listRolloutFiles(
  root: string,
  options: { sinceMs: number; maxFiles: number; log?: { warn: (message: string) => void } }
): Promise<RolloutFileCandidate[]> {
  const found: RolloutFileCandidate[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      options.log?.warn(
        `official key usage cannot read ${directory}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) {
        continue;
      }
      try {
        const info = await stat(entryPath);
        found.push({ path: entryPath, mtimeMs: info.mtimeMs, size: info.size });
      } catch (error) {
        options.log?.warn(
          `official key usage cannot stat ${entryPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  await walk(root, 0);

  return found
    .filter((candidate) => candidate.mtimeMs >= options.sinceMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(0, options.maxFiles));
}

function toSnapshot(row: OfficialKeyUsageDbRow): OfficialKeyUsageSnapshot {
  return {
    vendor: row.vendor,
    source: row.source,
    limitId: row.limitId,
    limitName: row.limitName,
    primary:
      row.primaryUsedPercent === null
        ? null
        : {
            usedPercent: row.primaryUsedPercent,
            windowMinutes: row.primaryWindowMinutes ?? 0,
            resetsAt: row.primaryResetsAt
          },
    secondary:
      row.secondaryUsedPercent === null
        ? null
        : {
            usedPercent: row.secondaryUsedPercent,
            windowMinutes: row.secondaryWindowMinutes ?? 0,
            resetsAt: row.secondaryResetsAt
          },
    credits:
      row.creditsHasCredits === null && row.creditsUnlimited === null
        ? null
        : { hasCredits: row.creditsHasCredits === 1, unlimited: row.creditsUnlimited === 1 },
    expiresAt: row.expiresAt,
    observedAt: row.observedAt
  };
}

function parseWindow(value: unknown): OfficialKeyUsageWindow | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const usedPercent = readFiniteNumber(record.used_percent);
  const windowMinutes = readFiniteNumber(record.window_minutes);
  const resetsAt = readResetTime(record.resets_at);
  if (usedPercent === null && windowMinutes === null && resetsAt === null) {
    return null;
  }

  return {
    usedPercent: usedPercent === null ? 0 : Math.max(0, usedPercent),
    windowMinutes: windowMinutes === null ? 0 : Math.max(0, Math.trunc(windowMinutes)),
    resetsAt
  };
}

function parseCredits(value: unknown): OfficialKeyUsageCredits | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const hasCredits = readBoolean(record.has_credits);
  const unlimited = readBoolean(record.unlimited);
  if (hasCredits === null && unlimited === null) {
    return null;
  }

  return { hasCredits: hasCredits ?? false, unlimited: unlimited ?? false };
}

function snapshotGroupKey(snapshot: OfficialKeyUsageSnapshot): string {
  return [
    snapshot.vendor,
    snapshot.limitId ?? "",
    windowKey(snapshot)
  ].join("|");
}

function windowKey(snapshot: OfficialKeyUsageSnapshot): string {
  return [snapshot.primary?.resetsAt ?? "", snapshot.secondary?.resetsAt ?? ""].join("|");
}

function compareSnapshots(left: OfficialKeyUsageSnapshot, right: OfficialKeyUsageSnapshot): number {
  return (
    left.vendor.localeCompare(right.vendor) ||
    (left.limitId ?? "").localeCompare(right.limitId ?? "") ||
    (right.observedAt > left.observedAt ? 1 : right.observedAt < left.observedAt ? -1 : 0)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Accepts unix seconds (real rollout data), milliseconds, or an ISO string. */
function readResetTime(value: unknown): string | null {
  if (typeof value === "string") {
    return readTimestamp(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const milliseconds = value > 1e11 ? value : value * 1000;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readTimestamp(value: unknown): string | null {
  if (typeof value === "number") {
    return readResetTime(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}