import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { persistOfficialKeyUsage, type OfficialKeyUsageSnapshot } from "./official-key-usage.js";
import type { SqliteDatabaseLike } from "./domain-types.js";

/**
 * ZCode coding-plan quota snapshots harvested from the official usage API.
 * The rolling 5-hour / weekly windows are never written to the desktop app log
 * (see `official-key-usage-zcode.ts`, which only sees the `billing/balance`
 * token buckets), so reading them means calling
 * `GET /api/monitor/usage/quota/limit` with the coding-plan API key stored in
 * `~/.zcode/v2/config.json`.
 *
 * The parser is intentionally self-contained instead of importing a ZCode
 * adapter: quota harvesting and event normalization evolve independently.
 */

export const ZCODE_QUOTA_API_VENDOR = "zcode";
export const ZCODE_QUOTA_API_SOURCE = "zcode-quota-api";

const DEFAULT_API_BASE_URL = "https://open.bigmodel.cn";
const QUOTA_LIMIT_PATH = "/api/monitor/usage/quota/limit";
const DEFAULT_TIMEOUT_MS = 8000;
/** The envelope reports success as `code: 200`; every other code is a failure. */
const SUCCESS_CODE = 200;
/** Primary first: the zai provider is the fallback and has been seen disabled. */
const CODING_PLAN_PROVIDER_IDS = ["builtin:bigmodel-coding-plan", "builtin:zai-coding-plan"];

/**
 * `unit` is a time-unit enum of the quota API and the ZCode bundle never names
 * it: the desktop app matches the literal `(type, unit, number)` triples
 * (`app.asar`), reading unit 3 as hours, 6 as weeks and 5 as months —
 *
 *   TOKENS_LIMIT 3×5 -> `settings.usage.entitlementFiveHourUsage` ("5-hour remaining")
 *   TOKENS_LIMIT 6   -> `settings.usage.entitlementWeeklyUsage` ("Weekly remaining")
 *   TIME_LIMIT   5×1 -> `settings.usage.entitlementMonthlyMcpUsage` ("Tool calls")
 *
 * which the observed `nextResetTime` spacing confirms: unit 6 resets 7 days
 * after unit 3, and unit 5 another 9 days out. Unknown units fall back to a
 * generic label and `windowMinutes: 0`.
 */
const UNIT_MINUTES: Record<number, number | undefined> = { 3: 60, 5: 43200, 6: 10080 };

type FetchLike = typeof fetch;

type Logger = {
  warn: (message: string) => void;
};

type QuotaFetchResult = { ok: true; text: string } | { ok: false; message: string };

export type CollectZCodeApiKeyUsageOptions = {
  configPath?: string;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: Logger;
};

export type CollectZCodeApiKeyUsageResult = {
  snapshotsFound: number;
  snapshotsStored: number;
};

/**
 * Quota-limit response -> one snapshot per entry of `data.limits`. Entries
 * carry a rolling window percentage, not absolute counts, so the tool-call
 * fields and the account `level` have no place in the contract and are dropped.
 * A missing or empty `limits` array yields no snapshot at all.
 */
export function parseZCodeQuotaLimits(
  payload: unknown,
  observedAt: string = new Date().toISOString()
): OfficialKeyUsageSnapshot[] {
  const envelope = asRecord(payload);
  const data = envelope === null ? null : asRecord(envelope.data);
  if (data === null || !Array.isArray(data.limits)) {
    return [];
  }

  const snapshots: OfficialKeyUsageSnapshot[] = [];
  for (const entry of data.limits) {
    const limit = asRecord(entry);
    if (limit === null) {
      continue;
    }
    const type = readNonEmptyString(limit.type);
    if (type === null) {
      continue;
    }
    const unit = readFiniteNumber(limit.unit);
    const number = readFiniteNumber(limit.number);

    snapshots.push({
      vendor: ZCODE_QUOTA_API_VENDOR,
      source: ZCODE_QUOTA_API_SOURCE,
      limitId: `${type}:${unit ?? "?"}:${number ?? "?"}`,
      limitName: limitNameOf(type, unit, number),
      primary: {
        usedPercent: clampPercent(readFiniteNumber(limit.percentage)),
        windowMinutes: windowMinutesOf(unit, number),
        resetsAt: readResetTime(limit.nextResetTime)
      },
      secondary: null,
      credits: null,
      expiresAt: null,
      observedAt
    });
  }

  return snapshots;
}

/**
 * Reads the coding-plan API key out of the ZCode config. Only the key is
 * returned and it is never logged; null means "no usable key" for either the
 * bigmodel provider or its zai fallback.
 */
export function readZCodeCodingPlanApiKey(
  configPath: string = resolveDefaultConfigPath()
): string | null {
  if (!existsSync(configPath)) {
    return null;
  }

  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  const record = parseJsonRecord(contents);
  const providers = record === null ? null : asRecord(record.provider);
  if (providers === null) {
    return null;
  }

  for (const providerId of CODING_PLAN_PROVIDER_IDS) {
    const provider = asRecord(providers[providerId]);
    const options = provider === null ? null : asRecord(provider.options);
    const apiKey = options === null ? null : readNonEmptyString(options.apiKey);
    if (apiKey !== null) {
      return apiKey;
    }
  }

  return null;
}

/** Global fetch cannot be detached from its binding on every runtime. */
const defaultFetch: FetchLike = async (input, init) => {
  return await globalThis.fetch(input, init);
};

/**
 * Reads the local coding-plan key and upserts whatever the quota endpoint
 * reports. A missing key, a failed request, or a non-200 envelope each log one
 * line and return zero counts instead of throwing.
 */
export async function collectZCodeApiKeyUsage(
  db: SqliteDatabaseLike,
  options: CollectZCodeApiKeyUsageOptions = {}
): Promise<CollectZCodeApiKeyUsageResult> {
  const now = options.now ?? (() => new Date());
  const log: Logger = options.log ?? { warn: (message: string) => console.warn(message) };
  const configPath = options.configPath ?? resolveDefaultConfigPath();
  const baseUrl = stripTrailingSlashes(options.apiBaseUrl ?? resolveDefaultApiBaseUrl());
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const collectedAt = now();

  const apiKey = readZCodeCodingPlanApiKey(configPath);
  if (apiKey === null) {
    log.warn(`official key usage skipped for zcode quota api: no coding plan api key in ${configPath}`);
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  const fetched = await requestZCodeQuotaLimits({ baseUrl, apiKey, fetchImpl });
  if (!fetched.ok) {
    log.warn(`official key usage request failed for zcode quota api: ${fetched.message}`);
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  const payload = parseJsonRecord(fetched.text);
  if (payload === null || readFiniteNumber(payload.code) !== SUCCESS_CODE) {
    log.warn(`official key usage response failed for zcode quota api: ${describeEnvelope(payload)}`);
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  const snapshots = parseZCodeQuotaLimits(payload, collectedAt.toISOString());
  return {
    snapshotsFound: snapshots.length,
    snapshotsStored: persistOfficialKeyUsage(db, snapshots, collectedAt.toISOString())
  };
}

/** Bearer is the documented scheme; `x-api-key` would be accepted as well. */
async function requestZCodeQuotaLimits(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
}): Promise<QuotaFetchResult> {
  let response: Response;
  try {
    response = await input.fetchImpl(`${input.baseUrl}${QUOTA_LIMIT_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      ok: false,
      message: `request failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!response.ok) {
    return { ok: false, message: `HTTP ${String(response.status)}` };
  }

  try {
    return { ok: true, text: await response.text() };
  } catch (error) {
    return {
      ok: false,
      message: `reading response failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** Mirrors the logs-root env var so tests never read the real HOME. */
function resolveDefaultConfigPath(): string {
  const fromEnv = readNonEmptyString(process.env.AGENT_METRICS_ZCODE_CONFIG_PATH);
  return fromEnv ?? join(homedir(), ".zcode", "v2", "config.json");
}

function resolveDefaultApiBaseUrl(): string {
  const fromEnv = readNonEmptyString(process.env.AGENT_METRICS_ZCODE_QUOTA_API_BASE);
  return fromEnv ?? DEFAULT_API_BASE_URL;
}

function limitNameOf(type: string, unit: number | null, number: number | null): string {
  if (type === "TOKENS_LIMIT") {
    if (unit === 3 && number === 5) {
      return "5h token limit";
    }
    // The app matches unit 6 without a number, so any count is the weekly window.
    if (unit === 6) {
      return "Weekly token limit";
    }
  }
  if (type === "TIME_LIMIT" && unit === 5 && number === 1) {
    return "Tool call limit";
  }
  return `${type} ${unit ?? "?"}×${number ?? "?"}`;
}

function windowMinutesOf(unit: number | null, number: number | null): number {
  const perUnit = unit === null ? undefined : UNIT_MINUTES[unit];
  if (perUnit === undefined) {
    return 0;
  }
  // The count multiplies the unit: 3×5 is five hours, 6×1 is one week.
  return perUnit * (number === null || number <= 0 ? 1 : number);
}

/** `nextResetTime` is unix milliseconds; seconds and ISO strings are tolerated. */
function readResetTime(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const milliseconds = value > 1e11 ? value : value * 1000;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clampPercent(value: number | null): number {
  return value === null ? 0 : Math.min(100, Math.max(0, value));
}

/** The API answers business errors with HTTP 200 and a non-200 `code`. */
function describeEnvelope(payload: Record<string, unknown> | null): string {
  if (payload === null) {
    return "unreadable response body";
  }
  const code = readFiniteNumber(payload.code);
  const message = readNonEmptyString(payload.msg);
  return [`code ${code === null ? "unknown" : String(code)}`, message].filter((part) => part !== null).join(" ");
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
