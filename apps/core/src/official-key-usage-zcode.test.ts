import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteDatabaseLike } from "./domain-types.js";
import { selectOfficialKeyUsage, type OfficialKeyUsageSnapshot } from "./official-key-usage.js";
import {
  collectZCodeKeyUsage,
  dedupeZCodeSnapshots,
  dropStaleZCodeEmptyState,
  extractZCodeSnapshotsFromLogText,
  isEmptyStateZCodeSnapshot,
  parseZCodeBalanceLogLine,
  parseZCodeBalancePayload
} from "./official-key-usage-zcode.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createDb(): SqliteDatabaseLike {
  return new Database(":memory:") as unknown as SqliteDatabaseLike;
}

/** Log timestamps carry no zone, so expectations must be built the same way. */
function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millis = 0
): string {
  return new Date(year, month - 1, day, hour, minute, second, millis).toISOString();
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_plan_id: "upl_2105121316546248704",
    plan_id: "zcode-v3-start-plan-trust-0930",
    name: "ZCode Trust Build",
    description: "ZCode Global Build",
    priority: 110,
    status: "active",
    starts_at: 1790735007,
    ends_at: 1790799999,
    entitlements: [
      {
        entitlement_id: "zcode-v3-start-plan-trust-0930",
        show_name: "GLM-5.3-Flash",
        meter: "model_usage",
        unit_type: "token",
        capabilities: ["model:glm-5.3-flash"],
        grant_units: 100000000,
        period: "one_time",
        priority: 110,
        effective_at: 0
      }
    ],
    ...overrides
  };
}

function tokenBucket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bucket_id: "bucket_2105121316592386048",
    user_plan_id: "upl_2105121316546248704",
    plan_id: "zcode-v3-start-plan-trust-0930",
    entitlement_id: "zcode-v3-start-plan-trust-0930",
    show_name: "GLM-5.3-Flash",
    meter: "model_usage",
    unit_type: "token",
    capabilities: ["model:glm-5.3-flash"],
    priority: 110,
    plan_priority: 110,
    entitlement_priority: 110,
    total_units: 100000000,
    used_units: 0,
    remaining_units: 100000000,
    available_units: 100000000,
    period_start: 1790735007,
    period_end: 1790784000,
    expires_at: 1790784000,
    ...overrides
  };
}

/** Real `billing/balance` body: outer transcription wrapper plus payload.data. */
function billingBody(input: { balances: unknown[]; plans?: unknown[]; code?: number }): string {
  const plans = input.plans ?? [plan()];
  return JSON.stringify({
    balanceCount: input.balances.length,
    balances: input.balances,
    code: 0,
    durationMs: 65,
    msg: "",
    payload: {
      code: input.code ?? 0,
      msg: "",
      data: { server_time: 1791594717, plans, balances: input.balances },
      logid: "202609300223275d9bc82f6e9abccc60d2"
    },
    planCount: plans.length,
    plans: plans.map((entry) => ({ plan_id: (entry as Record<string, unknown>).plan_id })),
    providerId: "account:bigmodel-start-plan",
    success: true,
    url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.4"
  });
}

function logLine(input: { body: string; timestamp?: string; tag?: string }): string {
  const tag = input.tag ?? "usage-stats";
  const timestamp = input.timestamp ?? "2026-09-30 10:23:27.844";
  return [
    "[2026-09-30 10:23:27.845] [info] [pid:43052] [main] [host-log] (local-1) [host]",
    `[${timestamp}] [pid:15732] [${tag}] billing/balance 请求完成 ${input.body}`
  ].join(" ");
}

function snapshot(input: Partial<OfficialKeyUsageSnapshot> & { observedAt: string }): OfficialKeyUsageSnapshot {
  return {
    vendor: input.vendor ?? "zcode",
    source: input.source ?? "zcode-billing-log",
    limitId: input.limitId === undefined ? "zcode-v3-start-plan-trust-0930" : input.limitId,
    limitName: input.limitName === undefined ? "GLM-5.3-Flash" : input.limitName,
    primary:
      input.primary === undefined
        ? { usedPercent: 10, windowMinutes: 825, resetsAt: "2026-10-01T00:00:00.000Z" }
        : input.primary,
    secondary: input.secondary === undefined ? null : input.secondary,
    credits: input.credits === undefined ? { hasCredits: true, unlimited: false } : input.credits,
    expiresAt: input.expiresAt === undefined ? "2026-10-01T04:26:39.000Z" : input.expiresAt,
    observedAt: input.observedAt
  };
}

describe("zcode key usage parsing", () => {
  it("parses a real billing/balance line into a bucket snapshot with the plan expiry", () => {
    const line = logLine({
      body: billingBody({ balances: [tokenBucket({ used_units: 25000000, remaining_units: 75000000 })] })
    });

    expect(parseZCodeBalanceLogLine(line)).toEqual([
      {
        vendor: "zcode",
        source: "zcode-billing-log",
        limitId: "zcode-v3-start-plan-trust-0930",
        limitName: "GLM-5.3-Flash",
        primary: {
          usedPercent: 25,
          windowMinutes: 817,
          resetsAt: new Date(1790784000 * 1000).toISOString()
        },
        secondary: null,
        credits: { hasCredits: true, unlimited: false },
        // The plan's ends_at wins over the bucket expiry.
        expiresAt: new Date(1790799999 * 1000).toISOString(),
        // The process logger's timestamp (the last one) is used, not the host wrapper's.
        observedAt: localIso(2026, 9, 30, 10, 23, 27, 844)
      }
    ]);
  });

  it("also reads the coding-plan-availability logger and reports full buckets", () => {
    const line = logLine({
      tag: "coding-plan-availability",
      body: billingBody({ balances: [tokenBucket()] })
    });

    const parsed = parseZCodeBalanceLogLine(line);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.credits).toEqual({ hasCredits: true, unlimited: false });
    expect(parsed[0]?.primary?.usedPercent).toBe(0);
  });

  it("falls back to the bucket expiry and then to null when no plan row matches", () => {
    const noPlan = parseZCodeBalancePayload(
      JSON.parse(billingBody({ balances: [tokenBucket()], plans: [] })) as unknown
    );
    expect(noPlan[0]?.expiresAt).toBe(new Date(1790784000 * 1000).toISOString());
    expect(noPlan[0]?.limitName).toBe("GLM-5.3-Flash");

    const noExpiry = parseZCodeBalancePayload(
      JSON.parse(
        billingBody({
          balances: [tokenBucket({ expires_at: null, period_end: null })],
          plans: []
        })
      ) as unknown
    );
    expect(noExpiry[0]?.expiresAt).toBeNull();
    expect(noExpiry[0]?.primary).toEqual({ usedPercent: 0, windowMinutes: 0, resetsAt: null });
  });

  it("accepts unix seconds, milliseconds, and ISO strings for the same field", () => {
    const payload = JSON.parse(
      billingBody({
        balances: [
          tokenBucket({
            period_start: 1790735007,
            period_end: "2026-10-01T00:00:00.000Z",
            expires_at: 1790789999000
          })
        ],
        plans: [plan({ ends_at: "2026-10-01T06:00:00.000Z" })]
      })
    ) as unknown;

    const parsed = parseZCodeBalancePayload(payload, { fallbackObservedAt: "2026-10-12T00:00:00.000Z" });
    expect(parsed[0]?.primary?.resetsAt).toBe(new Date(1790789999000).toISOString());
    expect(parsed[0]?.primary?.windowMinutes).toBe(1297);
    expect(parsed[0]?.expiresAt).toBe("2026-10-01T06:00:00.000Z");
  });

  it("yields one empty-state snapshot when the account has no active plan", () => {
    const line = logLine({ body: billingBody({ balances: [], plans: [] }) });

    expect(parseZCodeBalanceLogLine(line)).toEqual([
      {
        vendor: "zcode",
        source: "zcode-billing-log",
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        credits: { hasCredits: false, unlimited: false },
        expiresAt: null,
        observedAt: localIso(2026, 9, 30, 10, 23, 27, 844)
      }
    ]);
    expect(parseZCodeBalanceLogLine(line).filter(isEmptyStateZCodeSnapshot)).toHaveLength(1);

    // A body without a balances array is the same "no plan" state.
    const missingBalances = logLine({
      body: JSON.stringify({ payload: { code: 0, data: { plans: [], balances: null } } })
    });
    expect(parseZCodeBalanceLogLine(missingBalances)).toHaveLength(1);

    // Without a parsable line timestamp the caller-provided fallback (file mtime) is used.
    const noPrefix = "billing/balance 请求完成 " + billingBody({ balances: [], plans: [] });
    expect(parseZCodeBalanceLogLine(noPrefix, { fallbackObservedAt: "2026-10-12T03:00:00.000Z" })[0]?.observedAt).toBe(
      "2026-10-12T03:00:00.000Z"
    );
  });

  it("skips lines without the marker and lines with a broken payload", () => {
    const contents = [
      "[2026-09-30 10:23:27.844] [info] [pid:15732] [usage-stats] 官方 MCP 额度请求完成 {}",
      "billing/balance 请求完成 ",
      'billing/balance 请求完成 {"payload":{"code":0,"data":{"balances":[{',
      "billing/balance 请求完成 [1,2,3]",
      'billing/balance 请求完成 {"payload":{"code":1,"msg":"boom"}}',
      logLine({ body: billingBody({ balances: [tokenBucket()] }) })
    ].join("\n");

    const snapshots = extractZCodeSnapshotsFromLogText(contents);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.limitId).toBe("zcode-v3-start-plan-trust-0930");
  });

  it("dedupes repeated readings of one window and keeps the newest", () => {
    const deduped = dedupeZCodeSnapshots([
      snapshot({ observedAt: "2026-09-30T01:00:00.000Z" }),
      snapshot({
        observedAt: "2026-09-30T03:00:00.000Z",
        primary: { usedPercent: 42, windowMinutes: 825, resetsAt: "2026-10-01T00:00:00.000Z" }
      }),
      snapshot({ observedAt: "2026-09-30T02:00:00.000Z" }),
      snapshot({
        observedAt: "2026-09-30T04:00:00.000Z",
        primary: { usedPercent: 5, windowMinutes: 825, resetsAt: "2026-10-02T00:00:00.000Z" }
      }),
      snapshot({ observedAt: "2026-09-30T05:00:00.000Z", expiresAt: "2026-10-05T04:26:39.000Z" })
    ]);

    expect(deduped).toHaveLength(3);
    // Newest first: the reset window, the bare plan-expiry read, then the later window.
    expect(deduped.map((entry) => [entry.primary?.resetsAt, entry.expiresAt, entry.observedAt])).toEqual([
      ["2026-10-01T00:00:00.000Z", "2026-10-05T04:26:39.000Z", "2026-09-30T05:00:00.000Z"],
      ["2026-10-02T00:00:00.000Z", "2026-10-01T04:26:39.000Z", "2026-09-30T04:00:00.000Z"],
      ["2026-10-01T00:00:00.000Z", "2026-10-01T04:26:39.000Z", "2026-09-30T03:00:00.000Z"]
    ]);
  });

  it("drops a stale empty state but keeps it while no plan is active", () => {
    const empty = snapshot({ observedAt: "2026-09-30T01:00:00.000Z", limitId: null, limitName: null, primary: null, credits: { hasCredits: false, unlimited: false }, expiresAt: null });
    const laterEmpty = snapshot({ observedAt: "2026-09-30T06:00:00.000Z", limitId: null, limitName: null, primary: null, credits: { hasCredits: false, unlimited: false }, expiresAt: null });
    const active = snapshot({ observedAt: "2026-09-30T05:00:00.000Z" });

    expect(dropStaleZCodeEmptyState([empty, active]).map((entry) => entry.limitId)).toEqual([
      "zcode-v3-start-plan-trust-0930"
    ]);
    expect(dropStaleZCodeEmptyState([empty]).map((entry) => entry.limitId)).toEqual([null]);
    expect(dropStaleZCodeEmptyState([active, laterEmpty]).map((entry) => entry.observedAt)).toEqual([
      "2026-09-30T05:00:00.000Z",
      "2026-09-30T06:00:00.000Z"
    ]);
  });
});

describe("collectZCodeKeyUsage", () => {
  it("scans daily logs, dedupes the newest reading, and stores it", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-logs-");
    await writeFile(
      join(root, "2026-10-12.log"),
      [
        "[2026-10-12 09:00:00.000] [info] [pid:1] [usage-stats] 官方 MCP 额度请求 MCP 请求完成 {}",
        logLine({
          timestamp: "2026-10-12 09:00:00.100",
          body: billingBody({ balances: [tokenBucket({ used_units: 10000000, remaining_units: 90000000 })] })
        }),
        logLine({
          timestamp: "2026-10-12 10:00:00.200",
          body: billingBody({ balances: [tokenBucket({ used_units: 25000000, remaining_units: 75000000 })] })
        }),
        "not a log line at all"
      ].join("\n")
    );
    await writeFile(join(root, "notes.txt"), "ignored");

    const stale = join(root, "2026-09-01.log");
    await writeFile(stale, logLine({ timestamp: "2026-09-01 10:00:00.000", body: billingBody({ balances: [tokenBucket()] }) }));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    const db = createDb();
    const result = await collectZCodeKeyUsage(db, { logsRoot: root });

    expect(result).toEqual({ filesScanned: 1, recordsRead: 2, snapshotsFound: 2, snapshotsStored: 1 });

    const collected = selectOfficialKeyUsage(db, { vendor: "zcode" });
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      vendor: "zcode",
      source: "zcode-billing-log",
      limitId: "zcode-v3-start-plan-trust-0930",
      limitName: "GLM-5.3-Flash",
      observedAt: localIso(2026, 10, 12, 10, 0, 0, 200),
      primary: {
        usedPercent: 25,
        windowMinutes: 817,
        resetsAt: new Date(1790784000 * 1000).toISOString()
      },
      credits: { hasCredits: true, unlimited: false }
    });

    const rows = db
      .prepare<{ limitId: string | null; observedAt: string }>(
        "SELECT limit_id AS limitId, observed_at AS observedAt FROM official_key_usage WHERE vendor = ?"
      )
      .all("zcode");
    expect(rows).toEqual([
      { limitId: "zcode-v3-start-plan-trust-0930", observedAt: localIso(2026, 10, 12, 10, 0, 0, 200) }
    ]);
  });

  it("stores the empty state so the panel keeps showing zcode", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-empty-");
    await writeFile(
      join(root, "2026-10-12.log"),
      logLine({ timestamp: "2026-10-12 10:00:00.000", body: billingBody({ balances: [], plans: [] }) })
    );

    const db = createDb();
    await expect(collectZCodeKeyUsage(db, { logsRoot: root })).resolves.toEqual({
      filesScanned: 1,
      recordsRead: 1,
      snapshotsFound: 1,
      snapshotsStored: 1
    });

    const collected = selectOfficialKeyUsage(db, { vendor: "zcode" });
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      vendor: "zcode",
      limitId: null,
      limitName: null,
      primary: null,
      credits: { hasCredits: false, unlimited: false },
      observedAt: localIso(2026, 10, 12, 10, 0, 0)
    });
  });

  it("returns zeroed counts when the logs root does not exist", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-missing-");
    const db = createDb();

    await expect(collectZCodeKeyUsage(db, { logsRoot: join(root, "missing") })).resolves.toEqual({
      filesScanned: 0,
      recordsRead: 0,
      snapshotsFound: 0,
      snapshotsStored: 0
    });
    expect(selectOfficialKeyUsage(db)).toEqual([]);
  });

  it("honors AGENT_METRICS_ZCODE_LOGS_ROOT when no root is passed", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-env-");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "2026-10-12.log"), logLine({ body: billingBody({ balances: [tokenBucket()] }) }));
    const previousRoot = process.env.AGENT_METRICS_ZCODE_LOGS_ROOT;
    process.env.AGENT_METRICS_ZCODE_LOGS_ROOT = root;

    try {
      const db = createDb();
      await expect(collectZCodeKeyUsage(db)).resolves.toMatchObject({
        filesScanned: 1,
        recordsRead: 1,
        snapshotsStored: 1
      });
      expect(selectOfficialKeyUsage(db, { vendor: "zcode" })).toHaveLength(1);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.AGENT_METRICS_ZCODE_LOGS_ROOT;
      } else {
        process.env.AGENT_METRICS_ZCODE_LOGS_ROOT = previousRoot;
      }
    }
  });
});
