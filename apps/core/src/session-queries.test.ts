import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { selectTokenTrend } from "./session-queries.js";
import { runDomainMigrations, type SqliteDatabaseLike } from "./domain-migrations.js";
import type { MetricsDatabase } from "./core-types.js";
import type { ResolvedTimeScope, TimeScopeRange } from "./time-scope.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type UsageSeed = {
  eventId: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  runDomainMigrations(db as unknown as SqliteDatabaseLike, "2026-01-01T00:00:00.000Z");
  return db;
}

/**
 * claude-transcript rows are delta-semantic, so the displayed input token count
 * stored by the projection equals the reported input tokens.
 */
function seedUsage(db: InstanceType<typeof Database>, seeds: UsageSeed[]): void {
  const insert = db.prepare(`
    INSERT INTO usage_events (
      event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
      occurred_at, model_id, provider_id, input_token_semantics, usage_measurement,
      raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, server_tool_use, usage_source, semantic_fingerprint
    ) VALUES (?, 2, 'claude:default', 'claude-code', ?, ?,
      ?, 'claude-sonnet-4-20250514', 'anthropic', 'delta', 'increment',
      ?, ?, ?, ?, ?, '{}', 'claude-transcript', ?)
  `);

  for (const seed of seeds) {
    insert.run(
      seed.eventId,
      `ses-${seed.eventId}`,
      `msg-${seed.eventId}`,
      seed.createdAt,
      seed.inputTokens,
      seed.inputTokens,
      seed.outputTokens,
      seed.cacheCreationTokens ?? 0,
      seed.cacheReadTokens ?? 0,
      `fp-${seed.eventId}`
    );
  }
}

function trendFor(scope: ResolvedTimeScope, seeds: UsageSeed[]): ReturnType<typeof selectTokenTrend> {
  const db = createDb();
  seedUsage(db, seeds);
  const rows = selectTokenTrend(db as unknown as MetricsDatabase, scope);
  db.close();
  return rows;
}

function bucketsOf(scope: ResolvedTimeScope, seeds: UsageSeed[]): Array<{ bucket: string; label: string }> {
  return trendFor(scope, seeds).map((row) => ({ bucket: row.bucket, label: row.label }));
}

function customScope(windowStart: string, windowEnd: string, timezone = "UTC"): ResolvedTimeScope {
  return { mode: "custom", range: null, timezone, windowStart, windowEnd };
}

function presetScope(
  mode: "calendar" | "rolling",
  range: TimeScopeRange,
  windowStart: string,
  windowEnd: string
): ResolvedTimeScope {
  return { mode, range, timezone: "UTC", windowStart, windowEnd };
}

function lifetimeScope(timezone = "UTC"): ResolvedTimeScope {
  return { mode: "lifetime", range: "day", timezone, windowStart: null, windowEnd: null };
}

function isoPlus(fromIso: string, offsetMs: number): string {
  return new Date(Date.parse(fromIso) + offsetMs).toISOString();
}

describe("selectTokenTrend bucket granularity", () => {
  it("keeps hourly buckets inside a 48 hour span and merges same-hour usage", () => {
    const rows = trendFor(
      customScope("2026-03-01T00:00:00.000Z", "2026-03-02T06:00:00.000Z"),
      [
        {
          eventId: "hour-a",
          createdAt: "2026-03-01T10:05:00.000Z",
          inputTokens: 10,
          outputTokens: 1,
          cacheReadTokens: 2,
          cacheCreationTokens: 3
        },
        { eventId: "hour-b", createdAt: "2026-03-01T10:45:00.000Z", inputTokens: 20, outputTokens: 4 },
        { eventId: "hour-c", createdAt: "2026-03-01T11:05:00.000Z", inputTokens: 30, outputTokens: 5 }
      ]
    );

    expect(rows.map((row) => ({ bucket: row.bucket, label: row.label }))).toEqual([
      { bucket: "hour", label: "03-01 10:00" },
      { bucket: "hour", label: "03-01 11:00" }
    ]);
    expect(rows[0]).toMatchObject({
      bucketStart: "2026-03-01T10:05:00.000Z",
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 3,
      totalTokens: 40
    });
    expect(rows[0]?.cacheHitRate).toBeCloseTo(2 / 35, 6);
    expect(rows[1]).toMatchObject({ totalTokens: 35 });
  });

  it("switches to daily buckets just above 48 hours", () => {
    const seeds: UsageSeed[] = [
      { eventId: "edge-hour", createdAt: "2026-03-02T12:00:00.000Z", inputTokens: 10, outputTokens: 1 }
    ];
    const windowStart = "2026-03-01T00:00:00.000Z";
    const atEdge = isoPlus(windowStart, 48 * HOUR_MS);

    expect(bucketsOf(customScope(windowStart, atEdge), seeds)).toEqual([{ bucket: "hour", label: "03-02 12:00" }]);
    expect(bucketsOf(customScope(windowStart, isoPlus(atEdge, 60_000)), seeds)).toEqual([
      { bucket: "day", label: "03-02" }
    ]);
  });

  it("keeps daily buckets at the 45 day edge and switches to weeks above it", () => {
    const seeds: UsageSeed[] = [
      { eventId: "edge-day", createdAt: "2026-01-15T05:00:00.000Z", inputTokens: 10, outputTokens: 1 }
    ];
    const windowStart = "2026-01-01T00:00:00.000Z";
    const fortyFiveDays = isoPlus(windowStart, 45 * DAY_MS);

    expect(bucketsOf(customScope(windowStart, fortyFiveDays), seeds)).toEqual([{ bucket: "day", label: "01-15" }]);
    expect(bucketsOf(customScope(windowStart, isoPlus(fortyFiveDays, 60_000)), seeds)).toEqual([
      { bucket: "week", label: "1/12-1/18" }
    ]);
  });

  it("keeps weekly buckets at the 400 day edge and switches to natural months above it", () => {
    const seeds: UsageSeed[] = [
      { eventId: "edge-week", createdAt: "2026-01-15T05:00:00.000Z", inputTokens: 10, outputTokens: 1 }
    ];
    const windowStart = "2025-01-01T00:00:00.000Z";
    const fourHundredDays = isoPlus(windowStart, 400 * DAY_MS);

    expect(fourHundredDays).toBe("2026-02-05T00:00:00.000Z");
    expect(bucketsOf(customScope(windowStart, fourHundredDays), seeds)).toEqual([
      { bucket: "week", label: "1/12-1/18" }
    ]);
    expect(bucketsOf(customScope(windowStart, isoPlus(fourHundredDays, 60_000)), seeds)).toEqual([
      { bucket: "month", label: "2026-01" }
    ]);
  });

  it("assigns weeks to Monday in the scope timezone", () => {
    const rows = trendFor(
      customScope("2026-02-01T00:00:00.000Z", "2026-05-15T00:00:00.000Z", "Asia/Shanghai"),
      [
        // Sunday 23:00 in Asia/Shanghai -- still the week that started Monday 3/2.
        { eventId: "week-sunday", createdAt: "2026-03-08T15:00:00.000Z", inputTokens: 10, outputTokens: 1 },
        // Monday 01:00 local -- the next week starts eight hours later.
        { eventId: "week-monday", createdAt: "2026-03-08T17:00:00.000Z", inputTokens: 20, outputTokens: 2 },
        { eventId: "week-monday-late", createdAt: "2026-03-09T02:00:00.000Z", inputTokens: 30, outputTokens: 3 }
      ]
    );

    expect(rows.map((row) => ({ bucket: row.bucket, label: row.label }))).toEqual([
      { bucket: "week", label: "3/2-3/8" },
      { bucket: "week", label: "3/9-3/15" }
    ]);
    expect(rows[0]).toMatchObject({
      bucketStart: "2026-03-08T15:00:00.000Z",
      inputTokens: 10,
      totalTokens: 11
    });
    expect(rows[1]).toMatchObject({
      bucketStart: "2026-03-08T17:00:00.000Z",
      inputTokens: 50,
      totalTokens: 55
    });
  });

  it("labels weeks that cross month and year boundaries", () => {
    const scope = customScope("2025-11-01T00:00:00.000Z", "2026-05-15T00:00:00.000Z", "Asia/Shanghai");

    expect(
      bucketsOf(scope, [
        { eventId: "week-year", createdAt: "2025-12-31T02:00:00.000Z", inputTokens: 10, outputTokens: 1 },
        { eventId: "week-month", createdAt: "2026-04-01T02:00:00.000Z", inputTokens: 20, outputTokens: 2 }
      ])
    ).toEqual([
      { bucket: "week", label: "12/29-1/4" },
      { bucket: "week", label: "3/30-4/5" }
    ]);
  });

  it("buckets lifetime scopes by natural local months", () => {
    const rows = trendFor(lifetimeScope("Asia/Shanghai"), [
      { eventId: "month-dec", createdAt: "2025-12-15T05:00:00.000Z", inputTokens: 10, outputTokens: 1 },
      // 23:30 on 1/31 local (UTC+8) is still January; 01:30 is February.
      { eventId: "month-jan", createdAt: "2026-01-31T15:30:00.000Z", inputTokens: 20, outputTokens: 2 },
      { eventId: "month-feb", createdAt: "2026-01-31T17:30:00.000Z", inputTokens: 30, outputTokens: 3 },
      { eventId: "month-feb-late", createdAt: "2026-02-10T05:00:00.000Z", inputTokens: 40, outputTokens: 4 }
    ]);

    expect(rows.map((row) => ({ bucket: row.bucket, label: row.label }))).toEqual([
      { bucket: "month", label: "2025-12" },
      { bucket: "month", label: "2026-01" },
      { bucket: "month", label: "2026-02" }
    ]);
    expect(rows[2]).toMatchObject({
      bucketStart: "2026-01-31T17:30:00.000Z",
      inputTokens: 70,
      totalTokens: 77
    });
  });

  it("buckets running calendar and rolling presets on their nominal range", () => {
    const rollingDay = bucketsOf(
      presetScope("rolling", "day", "2026-03-02T00:00:00.000Z", "2026-03-02T00:30:00.000Z"),
      [{ eventId: "preset-rolling-day", createdAt: "2026-03-02T00:10:00.000Z", inputTokens: 10, outputTokens: 1 }]
    );
    // A calendar week is only hours old on Monday morning but stays daily.
    const calendarWeek = bucketsOf(
      presetScope("calendar", "week", "2026-03-02T00:00:00.000Z", "2026-03-02T03:00:00.000Z"),
      [{ eventId: "preset-calendar-week", createdAt: "2026-03-02T01:00:00.000Z", inputTokens: 20, outputTokens: 2 }]
    );
    const calendarMonth = bucketsOf(
      presetScope("calendar", "month", "2026-03-01T00:00:00.000Z", "2026-03-02T03:00:00.000Z"),
      [{ eventId: "preset-calendar-month", createdAt: "2026-03-01T20:00:00.000Z", inputTokens: 30, outputTokens: 3 }]
    );
    const rollingMonth = bucketsOf(
      presetScope("rolling", "month", "2026-02-01T00:00:00.000Z", "2026-02-20T00:00:00.000Z"),
      [{ eventId: "preset-rolling-month", createdAt: "2026-02-10T00:00:00.000Z", inputTokens: 40, outputTokens: 4 }]
    );

    expect(rollingDay).toEqual([{ bucket: "hour", label: "03-02 00:00" }]);
    expect(calendarWeek).toEqual([{ bucket: "day", label: "03-02" }]);
    expect(calendarMonth).toEqual([{ bucket: "day", label: "03-01" }]);
    expect(rollingMonth).toEqual([{ bucket: "day", label: "02-10" }]);
  });
});

describe("selectTokenTrend usage selection", () => {
  it("counts displayed input tokens and skips session-context snapshots", () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO usage_events (
        event_id, schema_version, source_instance_id, source_vendor, session_id, message_id,
        occurred_at, model_id, provider_id, input_token_semantics, usage_measurement,
        raw_input_tokens, displayed_input_tokens, output_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, server_tool_use, usage_source, semantic_fingerprint
      ) VALUES
        ('delta-1', 2, 'opencode:default', 'opencode', 'ses-open', 'msg-1',
         '2026-03-01T10:05:00.000Z', 'hy3-preview-free', 'opencode', 'gross', 'increment',
         27470, 25422, 207, 0, 2048, '{}', 'opencode-step-finish', 'fp-1'),
        ('snapshot-1', 2, 'cursor:default', 'cursor', 'ses-cursor', 'msg-2',
         '2026-03-01T10:06:00.000Z', 'composer-2', 'cursor', 'delta', 'session-context-snapshot',
         2500, 2500, 999, 0, 0, '{}', 'cursor-composer-context', 'fp-2')
    `).run();

    const rows = selectTokenTrend(
      db as unknown as MetricsDatabase,
      customScope("2026-03-01T00:00:00.000Z", "2026-03-02T06:00:00.000Z")
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "03-01 10:00",
      // displayed input (25422), not the gross raw input (27470)
      inputTokens: 25422,
      outputTokens: 207,
      cacheReadTokens: 2048,
      totalTokens: 27677
    });

    db.close();
  });
});
