import type { OfficialKeyUsageSnapshot, OfficialKeyUsageWindow } from "./official-key-usage.js";
import {
  asRecord,
  normalizeEpochMs,
  readFiniteNumber,
  readNonEmptyString,
  readTimestamp
} from "./official-key-usage-antigravity-values.js";

export const ANTIGRAVITY_KEY_USAGE_VENDOR = "antigravity";
export const ANTIGRAVITY_KEY_USAGE_SOURCE = "antigravity-quota-api";
export const ANTIGRAVITY_MANAGER_CACHE_SOURCE = "antigravity-manager-cache";

const FIVE_HOURS_MINUTES = 300;
const WEEKLY_MINUTES = 10080;


type QuotaLimit = {
  limitId: string;
  limitName: string;
  primary: OfficialKeyUsageWindow | null;
  secondary: OfficialKeyUsageWindow | null;
};

/**
 * Maps a `retrieveUserQuotaSummary` response into `OfficialKeyUsageSnapshot`
 * entries — one snapshot per model group (e.g. `Gemini Models`, `Claude and GPT
 * models`), pairing its `5h` bucket as `primary` and `weekly` bucket as
 * `secondary`.
 */
export function parseAntigravityQuotaSummary(
  payload: unknown,
  observedAt: string = new Date().toISOString(),
  requestedAtMs: number = Date.parse(observedAt)
): OfficialKeyUsageSnapshot[] {
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }

  const rawGroups = Array.isArray(record.groups) ? record.groups : [];
  const hasGroupBuckets = rawGroups.some((group) => {
    const groupRecord = asRecord(group);
    return groupRecord !== null && Array.isArray(groupRecord.buckets) && groupRecord.buckets.length > 0;
  });

  const groups: Array<{ displayName: string | null; buckets: unknown[] }> = hasGroupBuckets
    ? rawGroups
        .map((group) => {
          const groupRecord = asRecord(group);
          if (groupRecord === null || !Array.isArray(groupRecord.buckets)) {
            return null;
          }
          return {
            displayName: readNonEmptyString(groupRecord.displayName),
            buckets: groupRecord.buckets
          };
        })
        .filter((group): group is { displayName: string | null; buckets: unknown[] } => group !== null)
    : Array.isArray(record.buckets) && record.buckets.length > 0
      ? [{ displayName: null, buckets: record.buckets }]
      : [];

  if (groups.length === 0) {
    return [];
  }

  const groupedSnapshots = new Map<string, QuotaLimit>();

  for (const group of groups) {
    for (const rawBucket of group.buckets) {
      const bucket = asRecord(rawBucket);
      if (bucket === null || bucket.disabled === true) {
        continue;
      }

      const bucketId = readNonEmptyString(bucket.bucketId);
      const remainingFraction = readFiniteNumber(bucket.remainingFraction);
      if (bucketId === null || remainingFraction === null) {
        continue;
      }

      const windowKind = readNonEmptyString(bucket.window);
      const windowMinutes =
        windowKind === "5h" ? FIVE_HOURS_MINUTES : windowKind === "weekly" ? WEEKLY_MINUTES : 0;
      const resetsAt = resolveSummaryResetTime({
        resetTime: bucket.resetTime,
        remainingFraction,
        description: readNonEmptyString(bucket.description),
        windowMinutes,
        requestedAtMs
      });

      const windowValue: OfficialKeyUsageWindow = {
        usedPercent: fractionToUsedPercent(remainingFraction),
        windowMinutes,
        resetsAt
      };

      const identity = resolveBucketGroupIdentity(bucketId, group.displayName);
      let entry = groupedSnapshots.get(identity.limitId);
      if (entry === undefined) {
        entry = {
          limitId: identity.limitId,
          limitName: identity.limitName,
          primary: null,
          secondary: null
        };
        groupedSnapshots.set(identity.limitId, entry);
      }

      if (windowKind === "5h") {
        entry.primary = windowValue;
      } else if (windowKind === "weekly") {
        entry.secondary = windowValue;
      } else if (entry.primary === null) {
        entry.primary = windowValue;
      } else if (entry.secondary === null) {
        entry.secondary = windowValue;
      }
    }
  }

  return quotaSnapshots(groupedSnapshots.values(), observedAt);
}

/**
 * Maps an Antigravity Manager `accounts/<id>.json` `quota` object
 * (`quota_groups`) into `OfficialKeyUsageSnapshot` entries marked with
 * `antigravity-manager-cache`.
 */
export function parseAntigravityManagerQuota(
  quota: unknown,
  observedAt: string = new Date().toISOString()
): OfficialKeyUsageSnapshot[] {
  const record = asRecord(quota);
  if (record === null || record.is_forbidden === true) {
    return [];
  }

  const rawLastUpdated = readFiniteNumber(record.last_updated);
  const parsedObservedMs = Date.parse(observedAt);
  const requestedAtMs =
    rawLastUpdated !== null && rawLastUpdated > 0
      ? normalizeEpochMs(rawLastUpdated)
      : Number.isFinite(parsedObservedMs)
        ? parsedObservedMs
        : Date.now();

  const rawGroups = Array.isArray(record.quota_groups) ? record.quota_groups : [];
  if (rawGroups.length === 0) {
    return [];
  }

  const groups = rawGroups
    .map((group) => {
      const groupRecord = asRecord(group);
      if (groupRecord === null || !Array.isArray(groupRecord.buckets)) {
        return null;
      }
      const buckets = groupRecord.buckets
        .map((rawBucket) => {
          const bucket = asRecord(rawBucket);
          if (bucket === null) {
            return null;
          }
          return {
            bucketId: bucket.bucket_id ?? bucket.bucketId,
            window: bucket.window,
            remainingFraction: bucket.remaining_fraction ?? bucket.remainingFraction,
            resetTime: bucket.reset_time ?? bucket.resetTime,
            description: bucket.description,
            disabled: bucket.disabled
          };
        })
        .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null);
      return {
        displayName: readNonEmptyString(groupRecord.display_name ?? groupRecord.displayName),
        buckets
      };
    })
    .filter((group): group is NonNullable<typeof group> => group !== null);

  return parseAntigravityQuotaSummary({ groups }, observedAt, requestedAtMs).map((snapshot) => ({
    ...snapshot,
    source: ANTIGRAVITY_MANAGER_CACHE_SOURCE
  }));
}

/**
 * Fallback parser for `fetchAvailableModels` when `retrieveUserQuotaSummary`
 * returns no buckets (e.g. older accounts). Aggregates by provider family
 * (`Gemini`, `Claude`, `GPT`), keeping the highest `usedPercent` per family.
 */
export function parseAntigravityAvailableModels(
  payload: unknown,
  observedAt: string = new Date().toISOString()
): OfficialKeyUsageSnapshot[] {
  const record = asRecord(payload);
  const models = record === null ? null : asRecord(record.models);
  if (models === null) {
    return [];
  }

  const byFamily = new Map<string, QuotaLimit>();

  for (const [modelId, rawModel] of Object.entries(models)) {
    const model = asRecord(rawModel);
    if (model === null) {
      continue;
    }

    const family = resolveModelFamily(modelId, readNonEmptyString(model.modelProvider));
    if (family === null) {
      continue;
    }

    const quotaWindow = parseModelQuotaWindow(model.quotaInfo, 0);
    const weeklyWindow = parseModelQuotaWindow(model.weeklyQuotaInfo, WEEKLY_MINUTES);
    if (quotaWindow === null && weeklyWindow === null) {
      continue;
    }

    let entry = byFamily.get(family.limitId);
    if (entry === undefined) {
      entry = {
        limitId: family.limitId,
        limitName: family.limitName,
        primary: null,
        secondary: null
      };
      byFamily.set(family.limitId, entry);
    }

    if (
      quotaWindow !== null &&
      (entry.primary === null || quotaWindow.usedPercent > entry.primary.usedPercent)
    ) {
      entry.primary = quotaWindow;
    }
    if (
      weeklyWindow !== null &&
      (entry.secondary === null || weeklyWindow.usedPercent > entry.secondary.usedPercent)
    ) {
      entry.secondary = weeklyWindow;
    }
  }

  return quotaSnapshots(byFamily.values(), observedAt);
}

function quotaSnapshots(limits: Iterable<QuotaLimit>, observedAt: string): OfficialKeyUsageSnapshot[] {
  return [...limits]
    .filter((limit) => limit.primary !== null || limit.secondary !== null)
    .map((limit) => ({
      vendor: ANTIGRAVITY_KEY_USAGE_VENDOR,
      source: ANTIGRAVITY_KEY_USAGE_SOURCE,
      ...limit,
      credits: null,
      expiresAt: null,
      observedAt
    }));
}

function resolveBucketGroupIdentity(
  bucketId: string,
  groupDisplayName: string | null
): { limitId: string; limitName: string } {
  if (bucketId.startsWith("gemini-argon-")) {
    return { limitId: "gemini-argon", limitName: groupDisplayName ?? "Gemini Argon" };
  }
  if (bucketId.startsWith("gemini-carbon-")) {
    return { limitId: "gemini-carbon", limitName: groupDisplayName ?? "Gemini Carbon" };
  }
  if (bucketId.startsWith("gemini-")) {
    return { limitId: "gemini", limitName: groupDisplayName ?? "Gemini Models" };
  }
  if (bucketId.startsWith("3p-")) {
    return { limitId: "3p", limitName: groupDisplayName ?? "Claude and GPT models" };
  }
  const normalizedPrefix = bucketId.replace(/-(?:5h|weekly)$/u, "");
  return {
    limitId: normalizedPrefix.length > 0 ? normalizedPrefix : bucketId,
    limitName: groupDisplayName ?? (normalizedPrefix.length > 0 ? normalizedPrefix : bucketId)
  };
}

function resolveModelFamily(
  modelId: string,
  modelProvider: string | null
): { limitId: string; limitName: string } | null {
  if (modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")) {
    return { limitId: "gemini", limitName: "Gemini Models" };
  }
  if (modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")) {
    return { limitId: "claude", limitName: "Claude Models" };
  }
  if (modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")) {
    return { limitId: "gpt", limitName: "GPT Models" };
  }
  return null;
}

function parseModelQuotaWindow(
  value: unknown,
  windowMinutes: number
): OfficialKeyUsageWindow | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const remainingFraction = readFiniteNumber(record.remainingFraction);
  if (remainingFraction === null) {
    return null;
  }
  return {
    usedPercent: fractionToUsedPercent(remainingFraction),
    windowMinutes,
    resetsAt: readTimestamp(record.resetTime)
  };
}

/**
 * Unused buckets often report `remainingFraction: 1` with `resetTime ≈ now +
 * windowDuration`. Treat that synthetic rolling horizon as `null` so the UI
 * does not show a countdown before the window actually starts.
 */
function resolveSummaryResetTime(input: {
  resetTime: unknown;
  remainingFraction: number;
  description: string | null;
  windowMinutes: number;
  requestedAtMs: number;
}): string | null {
  const iso = readTimestamp(input.resetTime);
  if (iso === null) {
    return null;
  }
  if (
    input.remainingFraction === 1 &&
    input.description === null &&
    input.windowMinutes > 0 &&
    Number.isFinite(input.requestedAtMs) &&
    Math.abs(Date.parse(iso) - input.requestedAtMs - input.windowMinutes * 60_000) <= 60_000
  ) {
    return null;
  }
  return iso;
}

function fractionToUsedPercent(remainingFraction: number): number {
  const clampedRemaining = Math.min(1, Math.max(0, remainingFraction));
  return Number(((1 - clampedRemaining) * 100).toFixed(2));
}
