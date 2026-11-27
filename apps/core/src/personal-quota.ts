import { antigravityLimitIdForModel, type PersonalQuotaResponse, type PersonalQuotaTokens } from "@agent-metrics/contracts";
import type { SqliteDatabaseLike } from "./domain-types.js";
import { selectOfficialKeyUsage } from "./official-key-usage.js";

const WEEK_MINUTES = 7 * 24 * 60;

type TokenRow = {
  modelId: string | null;
  uncached: number;
  cacheRead: number;
  output: number;
};

function emptyTokens(): PersonalQuotaTokens {
  return { uncached: 0, cacheRead: 0, output: 0 };
}

function addTokens(target: PersonalQuotaTokens, row: TokenRow): void {
  target.uncached += row.uncached;
  target.cacheRead += row.cacheRead;
  target.output += row.output;
}

export function selectAntigravityTokenRows(
  db: SqliteDatabaseLike,
  sinceIso: string,
  untilIso: string
): TokenRow[] {
  return db
    .prepare<TokenRow>(
      `SELECT model_id AS modelId,
        COALESCE(SUM(displayed_input_tokens), 0) AS uncached,
        COALESCE(SUM(cache_read_input_tokens), 0) AS cacheRead,
        COALESCE(SUM(output_tokens), 0) AS output
      FROM usage_events
      WHERE source_vendor = 'antigravity'
        AND usage_measurement = 'increment'
        AND occurred_at >= ?
        AND occurred_at < ?
      GROUP BY model_id`
    )
    .all(sinceIso, untilIso);
}

/** Personal Antigravity token totals for each official weekly quota family. */
export function selectPersonalQuota(
  db: SqliteDatabaseLike,
  now: Date = new Date()
): PersonalQuotaResponse {
  const untilIso = now.toISOString();
  const snapshots = selectOfficialKeyUsage(db, { vendor: "antigravity" });
  const families: PersonalQuotaResponse["families"] = [];

  for (const snapshot of snapshots) {
    const weekly = snapshot.secondary;
    if (weekly === null || weekly.windowMinutes <= 0) {
      continue;
    }
    const resetMs = weekly.resetsAt === null ? Number.NaN : Date.parse(weekly.resetsAt);
    const durationMs = (weekly.windowMinutes || WEEK_MINUTES) * 60_000;
    const startMs = Number.isFinite(resetMs) ? resetMs - durationMs : now.getTime() - durationMs;
    const windowStart = new Date(startMs).toISOString();
    const tokens = emptyTokens();
    for (const row of selectAntigravityTokenRows(db, windowStart, untilIso)) {
      if (antigravityLimitIdForModel(row.modelId) !== snapshot.limitId) {
        continue;
      }
      addTokens(tokens, row);
    }
    families.push({
      limitId: snapshot.limitId ?? "antigravity",
      limitName: snapshot.limitName ?? "Antigravity",
      accountUsedPercent: weekly.usedPercent,
      resetsAt: weekly.resetsAt,
      windowStart,
      tokens
    });
  }

  return { families };
}
