import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  persistOfficialKeyUsage,
  type OfficialKeyUsageSnapshot
} from "./official-key-usage.js";
import type { SqliteDatabaseLike } from "./domain-types.js";

/**
 * Official key quota snapshots harvested from the ZCode desktop app log. ZCode
 * writes the raw `billing/balance` response into `~/.zcode/v2/logs/<date>.log`,
 * so plan entitlements and their token buckets are readable locally without any
 * network call.
 *
 * The parser is intentionally self-contained instead of importing a ZCode
 * adapter: quota harvesting and event normalization evolve independently.
 */

export const ZCODE_KEY_USAGE_VENDOR = "zcode";
export const ZCODE_KEY_USAGE_SOURCE = "zcode-billing-log";
/** Both the `[usage-stats]` and `[coding-plan-availability]` loggers emit this. */
export const ZCODE_BALANCE_MARKER = "billing/balance 请求完成 ";

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const LOG_TIMESTAMP_PATTERN =
  /\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/gu;

export type ZCodeKeyUsageContext = {
  vendor?: string;
  source?: string;
  /** ISO timestamp used when a log line carries no parsable timestamp. */
  fallbackObservedAt?: string;
};

export type CollectZCodeKeyUsageOptions = {
  logsRoot?: string;
  vendor?: string;
  source?: string;
  now?: () => Date;
  lookbackMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  log?: { warn: (message: string) => void };
};

export type CollectZCodeKeyUsageResult = {
  filesScanned: number;
  recordsRead: number;
  snapshotsFound: number;
  snapshotsStored: number;
};

type ZCodeScanContext = {
  vendor: string;
  source: string;
  fallbackObservedAt: string;
};

type ZCodeLogFileCandidate = {
  path: string;
  mtimeMs: number;
  size: number;
};

/**
 * One log line → the snapshots it carries: one per token bucket, or a single
 * empty-state snapshot when the account currently has no plan. Lines without
 * the billing marker or with a broken payload yield nothing.
 */
export function parseZCodeBalanceLogLine(
  line: string,
  context: ZCodeKeyUsageContext = {}
): OfficialKeyUsageSnapshot[] {
  const markerIndex = line.indexOf(ZCODE_BALANCE_MARKER);
  if (markerIndex < 0) {
    return [];
  }

  const payload = parseJsonRecord(line.slice(markerIndex + ZCODE_BALANCE_MARKER.length).trim());
  if (payload === null) {
    return [];
  }

  return parseZCodeBalancePayload(payload, {
    ...context,
    fallbackObservedAt: readLogLineTimestamp(line.slice(0, markerIndex)) ?? context.fallbackObservedAt
  });
}

/**
 * Maps a decoded `billing/balance` response onto snapshots. The authoritative
 * quota data lives in `payload.data`; the outer copy is a transcription wrapper.
 * An empty `balances` array is a valid state ("no active plan") and still yields
 * one snapshot, so the panel can render the empty state instead of stale data.
 */
export function parseZCodeBalancePayload(
  value: unknown,
  context: ZCodeKeyUsageContext = {}
): OfficialKeyUsageSnapshot[] {
  const envelope = asRecord(value);
  const payload = envelope === null ? null : asRecord(envelope.payload);
  const data = payload === null ? null : asRecord(payload.data);
  if (data === null) {
    return [];
  }

  const vendor = context.vendor ?? ZCODE_KEY_USAGE_VENDOR;
  const source = context.source ?? ZCODE_KEY_USAGE_SOURCE;
  const observedAt = context.fallbackObservedAt ?? new Date(0).toISOString();
  const plans = Array.isArray(data.plans) ? data.plans : [];
  const balances = Array.isArray(data.balances) ? data.balances : [];

  if (balances.length === 0) {
    return [
      {
        vendor,
        source,
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        credits: { hasCredits: false, unlimited: false },
        expiresAt: null,
        observedAt
      }
    ];
  }

  const snapshots: OfficialKeyUsageSnapshot[] = [];
  for (const entry of balances) {
    const balance = asRecord(entry);
    if (balance === null) {
      continue;
    }
    snapshots.push(toBalanceSnapshot(balance, plans, { vendor, source, fallbackObservedAt: observedAt }));
  }

  return snapshots;
}

/**
 * Reads ZCode quota snapshots out of log text. Lines without the billing marker
 * and lines with a broken payload are skipped rather than failing the scan.
 */
export function extractZCodeSnapshotsFromLogText(
  contents: string,
  context: ZCodeKeyUsageContext = {}
): OfficialKeyUsageSnapshot[] {
  const snapshots: OfficialKeyUsageSnapshot[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    snapshots.push(...parseZCodeBalanceLogLine(line, context));
  }
  return snapshots;
}

/** True for the synthesized "no active plan" snapshot. */
export function isEmptyStateZCodeSnapshot(snapshot: OfficialKeyUsageSnapshot): boolean {
  return snapshot.limitId === null && snapshot.primary === null;
}

/**
 * ZCode logs the same bucket on every poll. Keeping the newest snapshot per
 * (vendor, limit, window reset, plan expiry) drops those repeats while
 * preserving each distinct quota window.
 */
export function dedupeZCodeSnapshots(snapshots: OfficialKeyUsageSnapshot[]): OfficialKeyUsageSnapshot[] {
  const latest = new Map<string, OfficialKeyUsageSnapshot>();
  for (const snapshot of snapshots) {
    const key = [
      snapshot.vendor,
      snapshot.limitId ?? "",
      snapshot.primary?.resetsAt ?? "",
      snapshot.expiresAt ?? ""
    ].join("|");
    const existing = latest.get(key);
    if (existing === undefined || snapshot.observedAt >= existing.observedAt) {
      latest.set(key, snapshot);
    }
  }

  return [...latest.values()].sort(compareSnapshots);
}

/**
 * A stale empty state must not sit next to a live plan: the synthesized
 * "no active plan" snapshot is dropped as soon as any bucket was observed at or
 * after it. It survives while the account really has no plan.
 */
export function dropStaleZCodeEmptyState(snapshots: OfficialKeyUsageSnapshot[]): OfficialKeyUsageSnapshot[] {
  const newestActive = snapshots.reduce<string | null>(
    (newest, snapshot) =>
      isEmptyStateZCodeSnapshot(snapshot) || (newest !== null && newest >= snapshot.observedAt)
        ? newest
        : snapshot.observedAt,
    null
  );
  if (newestActive === null) {
    return snapshots;
  }

  return snapshots.filter(
    (snapshot) => !isEmptyStateZCodeSnapshot(snapshot) || snapshot.observedAt > newestActive
  );
}

/**
 * Scans ZCode daily logs under `~/.zcode/v2/logs` and upserts the newest quota
 * snapshot per (vendor, limit). Recently written files are scanned first and the
 * total work is bounded, so this is safe inside a refresh loop.
 */
export async function collectZCodeKeyUsage(
  db: SqliteDatabaseLike,
  options: CollectZCodeKeyUsageOptions = {}
): Promise<CollectZCodeKeyUsageResult> {
  const now = options.now ?? (() => new Date());
  const collectedAt = now();
  const vendor = options.vendor ?? ZCODE_KEY_USAGE_VENDOR;
  const source = options.source ?? ZCODE_KEY_USAGE_SOURCE;
  const logsRoot = options.logsRoot ?? resolveDefaultLogsRoot();
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const candidates = await listLogFiles(logsRoot, {
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

  const deduped = dropStaleZCodeEmptyState(dedupeZCodeSnapshots(snapshots));
  return {
    filesScanned,
    recordsRead,
    snapshotsFound: snapshots.length,
    snapshotsStored: persistOfficialKeyUsage(db, deduped, collectedAt.toISOString())
  };
}

/** Mirrors the Codex isolation env var so tests never read the real HOME. */
function resolveDefaultLogsRoot(): string {
  const fromEnv = process.env.AGENT_METRICS_ZCODE_LOGS_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return join(homedir(), ".zcode", "v2", "logs");
}

function toBalanceSnapshot(
  balance: Record<string, unknown>,
  plans: unknown[],
  context: ZCodeScanContext
): OfficialKeyUsageSnapshot {
  const plan = findMatchingPlan(
    plans,
    readOptionalString(balance.user_plan_id),
    readOptionalString(balance.plan_id)
  );
  const totalUnits = readFiniteNumber(balance.total_units) ?? 0;
  const usedUnits = readFiniteNumber(balance.used_units) ?? 0;
  const remainingUnits = readFiniteNumber(balance.remaining_units) ?? 0;
  const periodStart = readEpochSeconds(balance.period_start);
  const periodEnd = readEpochSeconds(balance.period_end);

  return {
    vendor: context.vendor,
    source: context.source,
    limitId: readOptionalString(balance.entitlement_id) ?? readOptionalString(balance.plan_id),
    limitName: readOptionalString(balance.show_name) ?? (plan === null ? null : readOptionalString(plan.name)),
    primary: {
      usedPercent: totalUnits > 0 ? (usedUnits / totalUnits) * 100 : 0,
      windowMinutes:
        periodStart === null || periodEnd === null
          ? 0
          : Math.max(0, Math.round((periodEnd - periodStart) / 60)),
      resetsAt: readResetTime(balance.expires_at) ?? readResetTime(balance.period_end)
    },
    secondary: null,
    credits: { hasCredits: remainingUnits > 0, unlimited: false },
    // The plan row owns the real expiry; the bucket expiry is the fallback.
    expiresAt: (plan === null ? null : readResetTime(plan.ends_at)) ?? readResetTime(balance.expires_at),
    observedAt: context.fallbackObservedAt
  };
}

/** Prefers the plan whose `user_plan_id` matches, then a shared `plan_id`. */
function findMatchingPlan(
  plans: unknown[],
  userPlanId: string | null,
  planId: string | null
): Record<string, unknown> | null {
  let byPlanId: Record<string, unknown> | null = null;
  for (const entry of plans) {
    const plan = asRecord(entry);
    if (plan === null) {
      continue;
    }
    if (userPlanId !== null && readOptionalString(plan.user_plan_id) === userPlanId) {
      return plan;
    }
    if (byPlanId === null && planId !== null && readOptionalString(plan.plan_id) === planId) {
      byPlanId = plan;
    }
  }
  return byPlanId;
}

/**
 * ZCode prefixes both the host wrapper and the process logger with a local-time
 * timestamp, e.g. `[ts] [info] [pid:1] [main] [host-log] [host] [ts] [pid:2]
 * [usage-stats]`. The last one is the timestamp the request was logged with.
 */
function readLogLineTimestamp(prefix: string): string | null {
  let timestamp: string | null = null;
  for (const match of prefix.matchAll(LOG_TIMESTAMP_PATTERN)) {
    timestamp = formatLogLineTimestamp(match) ?? timestamp;
  }
  return timestamp;
}

function formatLogLineTimestamp(match: RegExpMatchArray): string | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionText: string | undefined = match[7];
  const fraction = fractionText === undefined ? 0 : Number(fractionText.padEnd(3, "0"));
  if (![year, month, day, hour, minute, second, fraction].every(Number.isFinite)) {
    return null;
  }
  // Log timestamps carry no zone; they are written in the machine's local time.
  const parsed = new Date(year, month - 1, day, hour, minute, second, fraction);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function readSnapshotsFromFile(
  filePath: string,
  context: ZCodeScanContext & { log?: { warn: (message: string) => void } }
): Promise<{ snapshots: OfficialKeyUsageSnapshot[]; recordsRead: number }> {
  const snapshots: OfficialKeyUsageSnapshot[] = [];
  let recordsRead = 0;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.includes(ZCODE_BALANCE_MARKER)) {
        continue;
      }
      recordsRead += 1;
      snapshots.push(...parseZCodeBalanceLogLine(line, context));
    }
  } catch (error) {
    context.log?.warn(
      `zcode key usage scan failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    lines.close();
    stream.destroy();
  }

  return { snapshots, recordsRead };
}

/** Daily logs live flat under the logs root, newest file first. */
async function listLogFiles(
  root: string,
  options: { sinceMs: number; maxFiles: number; log?: { warn: (message: string) => void } }
): Promise<ZCodeLogFileCandidate[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    options.log?.warn(
      `zcode key usage cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }

  const found: ZCodeLogFileCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".log")) {
      continue;
    }
    const entryPath = join(root, entry.name);
    try {
      const info = await stat(entryPath);
      if (info.mtimeMs >= options.sinceMs) {
        found.push({ path: entryPath, mtimeMs: info.mtimeMs, size: info.size });
      }
    } catch (error) {
      options.log?.warn(
        `zcode key usage cannot stat ${entryPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return found
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(0, options.maxFiles));
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

/** Accepts unix seconds (real log data), milliseconds, or an ISO string. */
function readEpochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? Math.floor(value / 1000) : value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}

function readResetTime(value: unknown): string | null {
  const seconds = readEpochSeconds(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}
