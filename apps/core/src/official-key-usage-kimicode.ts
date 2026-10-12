import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { persistOfficialKeyUsage, type OfficialKeyUsageSnapshot } from "./official-key-usage.js";
import type { SqliteDatabaseLike } from "./domain-types.js";

/**
 * Kimi Code quota snapshots harvested from the official usage API. Unlike
 * Codex rollouts, Kimi Code keeps no local quota artifact, so this collector
 * reads the local OAuth credentials and calls the managed usage endpoint. A
 * refreshed token is used for this run only and is never written back to the
 * credentials file — the CLI owns that state.
 */

export const KIMICODE_KEY_USAGE_VENDOR = "kimicode";
export const KIMICODE_KEY_USAGE_SOURCE = "kimicode-api";

const DEFAULT_API_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const KIMICODE_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const EXPIRES_SKEW_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type FetchLike = typeof fetch;

type Logger = {
  warn: (message: string) => void;
  info?: (message: string) => void;
};

type QuotaWindowKind = {
  limitId: string;
  limitName: string;
  windowMinutes: number;
};

const USED_RATIO_FIELD = "used_ratio";
const RESET_TIME_FIELD = "reset_time";

const QUOTA_WINDOWS: QuotaWindowKind[] = [
  { limitId: "limit_5h", limitName: "5h limit", windowMinutes: 300 },
  { limitId: "limit_7d", limitName: "Weekly limit", windowMinutes: 10080 },
  { limitId: "limit_month_total", limitName: "Monthly total", windowMinutes: 43200 },
  { limitId: "limit_month_code", limitName: "Monthly code", windowMinutes: 43200 }
];

export type KimicodeCredentials = {
  accessToken: string;
  refreshToken: string | null;
  /** Unix milliseconds, or null when the source omitted it. */
  expiresAt: number | null;
};

export type CollectKimicodeKeyUsageOptions = {
  credentialsPath?: string;
  apiBaseUrl?: string;
  oauthHost?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: Logger;
};

export type CollectKimicodeKeyUsageResult = {
  snapshotsFound: number;
  snapshotsStored: number;
};

export type KimicodeUsageSnapshot = OfficialKeyUsageSnapshot;

type UsageFetchResult =
  | { ok: true; text: string }
  | { ok: false; status: number | null; message: string };

/**
 * Managed `/usages` payload → snapshots. One quota window key per snapshot plus
 * an optional booster-wallet entry; missing keys are skipped, and a payload
 * with neither section yields no snapshots.
 */
export function parseKimicodeUsages(
  payload: unknown,
  observedAt: string = new Date().toISOString()
): OfficialKeyUsageSnapshot[] {
  return mapKimicodeUsages(payload, observedAt);
}

/**
 * Reads the local Kimi Code credentials file. Field values are never logged;
 * null means "not logged in" or an unusable file.
 */
export function readKimicodeCredentials(
  credentialsPath: string = resolveDefaultCredentialsPath()
): KimicodeCredentials | null {
  if (!existsSync(credentialsPath)) {
    return null;
  }

  let contents: string;
  try {
    contents = readFileSync(credentialsPath, "utf8");
  } catch {
    return null;
  }

  const record = parseJsonRecord(contents);
  if (record === null) {
    return null;
  }
  const accessToken = readNonEmptyString(record.access_token);
  if (accessToken === null) {
    return null;
  }

  return {
    accessToken,
    refreshToken: readNonEmptyString(record.refresh_token),
    expiresAt: readExpiryMs(record.expires_at)
  };
}

/** Global fetch cannot be detached from its binding on every runtime. */
const defaultFetch: FetchLike = async (input, init) => {
  return await globalThis.fetch(input, init);
};

/**
 * Calls `GET {base}/usages` with the access token. A request answered with 401
 * triggers exactly one token refresh and retry; any other failure is reported
 * to the caller, which turns it into an empty collection.
 */
async function fetchKimicodeUsages(input: {
  baseUrl: string;
  oauthHost: string;
  credentials: KimicodeCredentials;
  fetchImpl: FetchLike;
  now: () => Date;
  log: Logger;
}): Promise<UsageFetchResult> {
  const url = `${input.baseUrl}/usages`;
  let accessToken = input.credentials.accessToken;

  if (isTokenExpired(input.credentials.expiresAt, input.now)) {
    const refreshed = await refreshKimicodeAccessToken({
      oauthHost: input.oauthHost,
      refreshToken: input.credentials.refreshToken,
      fetchImpl: input.fetchImpl,
      log: input.log
    });
    // Keep going when the refresh fails: the stored token may still be accepted,
    // and a 401 below gets one more refresh attempt before the run is abandoned.
    if (refreshed !== null) {
      accessToken = refreshed;
    }
  }

  let result = await requestKimicodeUsages({
    url,
    accessToken,
    fetchImpl: input.fetchImpl
  });

  if (result.ok || result.status !== 401) {
    return result;
  }

  const refreshed = await refreshKimicodeAccessToken({
    oauthHost: input.oauthHost,
    refreshToken: input.credentials.refreshToken,
    fetchImpl: input.fetchImpl,
    log: input.log
  });
  if (refreshed === null) {
    input.log.warn("official key usage refresh failed for kimicode; skipping collection");
    return { ok: false, status: result.status, message: result.message };
  }

  return await requestKimicodeUsages({ url, accessToken: refreshed, fetchImpl: input.fetchImpl });
}

async function requestKimicodeUsages(input: {
  url: string;
  accessToken: string;
  fetchImpl: FetchLike;
}): Promise<UsageFetchResult> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: `request failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, message: `HTTP ${String(response.status)}` };
  }

  try {
    return { ok: true, text: await response.text() };
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      message: `reading response failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Standard OAuth2 refresh-token grant against the Kimi OAuth host. The refreshed
 * token stays in memory for this run; the credentials file is never rewritten.
 */
async function refreshKimicodeAccessToken(input: {
  oauthHost: string;
  refreshToken: string | null;
  fetchImpl: FetchLike;
  log: Logger;
}): Promise<string | null> {
  if (input.refreshToken === null) {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: KIMICODE_OAUTH_CLIENT_ID
  });

  let response: Response;
  try {
    response = await input.fetchImpl(`${input.oauthHost}/api/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    input.log.warn(
      `official key usage token refresh failed for kimicode: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  if (!response.ok) {
    input.log.warn(`official key usage token refresh failed for kimicode (HTTP ${String(response.status)})`);
    return null;
  }

  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return null;
    }
    const record = parseJsonRecord(text);
    return record === null ? null : readNonEmptyString(record.access_token);
  } catch {
    return null;
  }
}

/**
 * Reads the local credentials and upserts whatever the official usage endpoint
 * reports. Missing credentials, a failed refresh, or a failed request all log
 * one line and return zero counts instead of throwing.
 */
export async function collectKimicodeKeyUsage(
  db: SqliteDatabaseLike,
  options: CollectKimicodeKeyUsageOptions = {}
): Promise<CollectKimicodeKeyUsageResult> {
  const now = options.now ?? (() => new Date());
  const log: Logger = options.log ?? { warn: (message: string) => console.warn(message) };
  const credentialsPath = options.credentialsPath ?? resolveDefaultCredentialsPath();
  const baseUrl = stripTrailingSlashes(
    options.apiBaseUrl ?? readNonEmptyString(process.env.KIMI_CODE_BASE_URL) ?? DEFAULT_API_BASE_URL
  );
  const oauthHost = stripTrailingSlashes(
    options.oauthHost ??
      readNonEmptyString(process.env.KIMI_CODE_OAUTH_HOST) ??
      readNonEmptyString(process.env.KIMI_OAUTH_HOST) ??
      DEFAULT_OAUTH_HOST
  );
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const collectedAt = now();

  const credentials = readKimicodeCredentials(credentialsPath);
  if (credentials === null) {
    log.info?.("official key usage skipped for kimicode: no local credentials");
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  const fetched = await fetchKimicodeUsages({
    baseUrl,
    oauthHost,
    credentials,
    fetchImpl,
    now,
    log
  });
  if (!fetched.ok) {
    log.warn(`official key usage request failed for kimicode: ${fetched.message}`);
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  const payload = parseJsonRecord(fetched.text);
  const snapshots = parseKimicodeUsages(payload, collectedAt.toISOString());
  return {
    snapshotsFound: snapshots.length,
    snapshotsStored: persistOfficialKeyUsage(db, snapshots, collectedAt.toISOString())
  };
}

function mapKimicodeUsages(payload: unknown, observedAt: string): OfficialKeyUsageSnapshot[] {
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }

  const snapshots: OfficialKeyUsageSnapshot[] = [];
  const usages = asRecord(record.usages);

  if (usages !== null) {
    for (const window of QUOTA_WINDOWS) {
      const entry = asRecord(usages[window.limitId]);
      if (entry === null) {
        continue;
      }
      const usedRatio = readFiniteNumber(entry[USED_RATIO_FIELD]);
      if (usedRatio === null) {
        continue;
      }
      snapshots.push({
        vendor: KIMICODE_KEY_USAGE_VENDOR,
        source: KIMICODE_KEY_USAGE_SOURCE,
        limitId: window.limitId,
        limitName: window.limitName,
        primary: {
          usedPercent: clampRatio(usedRatio) * 100,
          windowMinutes: window.windowMinutes,
          resetsAt: readResetTime(entry[RESET_TIME_FIELD])
        },
        secondary: null,
        credits: null,
        expiresAt: null,
        observedAt
      });
    }
  }

  const booster = parseBoosterWallet(record.boosterWallet);
  if (booster !== null) {
    snapshots.push({
      vendor: KIMICODE_KEY_USAGE_VENDOR,
      source: KIMICODE_KEY_USAGE_SOURCE,
      limitId: "booster-wallet",
      limitName: "Booster wallet",
      primary: null,
      secondary: null,
      credits: booster,
      expiresAt: null,
      observedAt
    });
  }

  return snapshots;
}

/** The wallet entry carries a fixed-point balance (1e6 units = 1 cent). */
function parseBoosterWallet(value: unknown): OfficialKeyUsageSnapshot["credits"] {
  const record = asRecord(value);
  const balance = record === null ? null : asRecord(record.balance);
  if (balance === null) {
    return null;
  }

  const amountLeft = readFiniteNumber(balance.amountLeft);
  if (amountLeft === null) {
    return null;
  }

  return { hasCredits: amountLeft > 0, unlimited: false };
}

function resolveDefaultCredentialsPath(): string {
  return (
    readNonEmptyString(process.env.AGENT_METRICS_KIMICODE_CREDENTIALS_PATH) ??
    join(homedir(), ".kimi-code", "credentials", "kimi-code.json")
  );
}

function isTokenExpired(expiresAtMs: number | null, now: () => Date): boolean {
  if (expiresAtMs === null) {
    return false;
  }
  return expiresAtMs - now().getTime() < EXPIRES_SKEW_MS;
}

function readExpiryMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  // Unix seconds are the CLI's own storage format; milliseconds pass through.
  return value > 1e11 ? value : value * 1000;
}

/** Accepts unix seconds, milliseconds, or an ISO string. */
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
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/u, "");
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

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}