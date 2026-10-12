import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectOfficialKeyUsage } from "./official-key-usage.js";
import {
  collectZCodeApiKeyUsage,
  parseZCodeQuotaLimits,
  readZCodeCodingPlanApiKey
} from "./official-key-usage-zcode-api.js";
import type { SqliteDatabaseLike } from "./domain-types.js";

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

const NOW = new Date("2026-10-12T01:00:00.000Z");
const OBSERVED_AT = "2026-10-12T00:00:00.000Z";
const FAKE_API_KEY = "0123456789abcdef0123456789abcdef0123456789abcd";
const ZAI_API_KEY = "zai-0123456789abcdef0123456789abcdef0123";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";

function isoFromUnixMs(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

/** The response body observed from `GET /api/monitor/usage/quota/limit`. */
function quotaLimitPayload(): unknown {
  return {
    code: 200,
    msg: "操作成功",
    data: {
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 18,
          remaining: 982,
          percentage: 1,
          nextResetTime: 1793185222983,
          usageDetails: [
            { modelCode: "search-prime", usage: 15 },
            { modelCode: "web-reador", usage: 3 }
          ]
        },
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 37,
          nextResetTime: 1791808234718
        },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 1,
          percentage: 7,
          nextResetTime: 1792395000981
        }
      ],
      level: "pro"
    },
    success: true
  };
}

function limitsPayload(limits: unknown): unknown {
  return { code: 200, msg: "操作成功", data: { limits, level: "pro" }, success: true };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function writeConfig(path: string, providers: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify({ provider: providers }));
}

type RecordedCall = { url: string; init?: RequestInit };

function recordCalls(
  payload: unknown = quotaLimitPayload(),
  status = 200
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse(payload, status);
  });
  return { calls, fetchImpl };
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

describe("parseZCodeQuotaLimits", () => {
  it("maps every limit of the observed response into a snapshot", () => {
    const snapshots = parseZCodeQuotaLimits(quotaLimitPayload(), OBSERVED_AT);

    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((entry) => entry.limitId)).toEqual([
      "TIME_LIMIT:5:1",
      "TOKENS_LIMIT:3:5",
      "TOKENS_LIMIT:6:1"
    ]);
    expect(snapshots[0]).toMatchObject({
      vendor: "zcode",
      source: "zcode-quota-api",
      limitName: "Tool call limit",
      primary: {
        usedPercent: 1,
        windowMinutes: 43200,
        resetsAt: "2026-10-28T11:00:22.983Z"
      },
      secondary: null,
      credits: null,
      expiresAt: null,
      observedAt: OBSERVED_AT
    });
    expect(snapshots[1]).toMatchObject({
      vendor: "zcode",
      source: "zcode-quota-api",
      limitName: "5h token limit",
      primary: {
        usedPercent: 37,
        windowMinutes: 300,
        resetsAt: "2026-10-12T12:30:34.718Z"
      }
    });
    expect(snapshots[2]).toMatchObject({
      limitName: "Weekly token limit",
      primary: {
        usedPercent: 7,
        windowMinutes: 10080,
        resetsAt: "2026-10-19T07:30:00.981Z"
      }
    });
  });

  it("drops the tool-call counters and the account level", () => {
    const [snapshot] = parseZCodeQuotaLimits(quotaLimitPayload(), OBSERVED_AT);

    expect(Object.keys(snapshot ?? {}).sort()).toEqual([
      "credits",
      "expiresAt",
      "limitId",
      "limitName",
      "observedAt",
      "primary",
      "secondary",
      "source",
      "vendor"
    ]);
    expect(Object.keys(snapshot?.primary ?? {}).sort()).toEqual([
      "resetsAt",
      "usedPercent",
      "windowMinutes"
    ]);
  });

  it("resolves the window from unit and number", () => {
    const snapshots = parseZCodeQuotaLimits(
      limitsPayload([
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10, nextResetTime: 1791808234718 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20, nextResetTime: 1792395000981 },
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 30, nextResetTime: 1793185222983 },
        { type: "TOKENS_LIMIT", unit: 9, number: 2, percentage: 40, nextResetTime: 1791808234718 },
        { type: "TOKENS_LIMIT", number: 1, percentage: 50 },
        { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 60 }
      ]),
      OBSERVED_AT
    );

    expect(
      snapshots.map((entry) => [entry.limitName, entry.primary?.windowMinutes])
    ).toEqual([
      ["5h token limit", 300],
      ["Weekly token limit", 10080],
      ["Tool call limit", 43200],
      ["TOKENS_LIMIT 9×2", 0],
      ["TOKENS_LIMIT ?×1", 0],
      ["CREDIT_LIMIT 3×5", 60 * 5]
    ]);
    expect(snapshots.map((entry) => entry.limitId)).toEqual([
      "TOKENS_LIMIT:3:5",
      "TOKENS_LIMIT:6:1",
      "TIME_LIMIT:5:1",
      "TOKENS_LIMIT:9:2",
      "TOKENS_LIMIT:?:1",
      "CREDIT_LIMIT:3:5"
    ]);
    expect(snapshots.map((entry) => entry.primary?.resetsAt)).toEqual([
      "2026-10-12T12:30:34.718Z",
      "2026-10-19T07:30:00.981Z",
      "2026-10-28T11:00:22.983Z",
      "2026-10-12T12:30:34.718Z",
      null,
      null
    ]);
  });

  it("clamps the percentage and tolerates missing fields", () => {
    const snapshots = parseZCodeQuotaLimits(
      limitsPayload([
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 143, nextResetTime: 0 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: -5 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, nextResetTime: "2026-10-12T12:30:34.718Z" },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: 1791808234 },
        { unit: 3, number: 5, percentage: 12 },
        null,
        42
      ]),
      OBSERVED_AT
    );

    expect(snapshots.map((entry) => entry.primary?.usedPercent)).toEqual([100, 0, 0, 12]);
    expect(snapshots.map((entry) => entry.primary?.resetsAt)).toEqual([
      null,
      null,
      "2026-10-12T12:30:34.718Z",
      isoFromUnixMs(1791808234000)
    ]);
    expect(snapshots.map((entry) => entry.observedAt)).toEqual([
      OBSERVED_AT,
      OBSERVED_AT,
      OBSERVED_AT,
      OBSERVED_AT
    ]);
  });

  it("returns no snapshot when the limits list is missing, empty, or not a list", () => {
    expect(parseZCodeQuotaLimits(limitsPayload([]), OBSERVED_AT)).toEqual([]);
    expect(parseZCodeQuotaLimits({ code: 200, data: {}, success: true }, OBSERVED_AT)).toEqual([]);
    expect(parseZCodeQuotaLimits({ code: 200, data: { limits: "none" } }, OBSERVED_AT)).toEqual([]);
    expect(parseZCodeQuotaLimits({ code: 200, data: null }, OBSERVED_AT)).toEqual([]);
    expect(parseZCodeQuotaLimits({ code: 401, msg: "令牌已过期或验证不正确", success: false }, OBSERVED_AT)).toEqual([]);
    expect(parseZCodeQuotaLimits(undefined, OBSERVED_AT)).toEqual([]);
  });

  it("defaults the observation time to now", () => {
    const snapshots = parseZCodeQuotaLimits(quotaLimitPayload());

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describe("readZCodeCodingPlanApiKey", () => {
  it("reads the bigmodel coding-plan key", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-config-");
    const configPath = join(root, "config.json");
    await writeConfig(configPath, {
      "builtin:bigmodel-coding-plan": { name: "Coding Plan", options: { apiKey: FAKE_API_KEY } }
    });

    expect(readZCodeCodingPlanApiKey(configPath)).toBe(FAKE_API_KEY);
  });

  it("prefers the bigmodel provider and falls back to the zai provider", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-config-fallback-");
    const bothPath = join(root, "both.json");
    await writeConfig(bothPath, {
      "builtin:zai-coding-plan": { options: { apiKey: ZAI_API_KEY } },
      "builtin:bigmodel-coding-plan": { options: { apiKey: FAKE_API_KEY } }
    });
    expect(readZCodeCodingPlanApiKey(bothPath)).toBe(FAKE_API_KEY);

    // The zai provider ships with an empty key while it is disabled.
    const emptyBigmodelPath = join(root, "empty-bigmodel.json");
    await writeConfig(emptyBigmodelPath, {
      "builtin:bigmodel-coding-plan": { options: { apiKey: "   " } },
      "builtin:zai-coding-plan": { options: { apiKey: ZAI_API_KEY } }
    });
    expect(readZCodeCodingPlanApiKey(emptyBigmodelPath)).toBe(ZAI_API_KEY);
  });

  it("returns null for a missing, malformed, or key-less config", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-config-bad-");

    expect(readZCodeCodingPlanApiKey(join(root, "missing.json"))).toBeNull();

    const brokenPath = join(root, "broken.json");
    await writeFile(brokenPath, "{not json");
    expect(readZCodeCodingPlanApiKey(brokenPath)).toBeNull();

    const providerlessPath = join(root, "providerless.json");
    await writeFile(providerlessPath, JSON.stringify({ other: {} }));
    expect(readZCodeCodingPlanApiKey(providerlessPath)).toBeNull();

    const noKeyPath = join(root, "no-key.json");
    await writeConfig(noKeyPath, { "builtin:bigmodel-coding-plan": { options: { baseURL: "https://x" } } });
    expect(readZCodeCodingPlanApiKey(noKeyPath)).toBeNull();

    const emptyKeyPath = join(root, "empty-key.json");
    await writeConfig(emptyKeyPath, { "builtin:bigmodel-coding-plan": { options: { apiKey: "" } } });
    expect(readZCodeCodingPlanApiKey(emptyKeyPath)).toBeNull();
  });
});

describe("collectZCodeApiKeyUsage", () => {
  it("calls the quota endpoint with the coding-plan key and stores the snapshots", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-collect-");
    const configPath = join(root, "config.json");
    await writeConfig(configPath, {
      "builtin:bigmodel-coding-plan": { options: { apiKey: FAKE_API_KEY, baseURL: "https://open.bigmodel.cn/api/anthropic" } }
    });

    const { calls, fetchImpl } = recordCalls();
    const db = createDb();
    const result = await collectZCodeApiKeyUsage(db, {
      configPath,
      apiBaseUrl: "https://quota.zcode.test/",
      fetchImpl,
      now: () => NOW
    });

    expect(result).toEqual({ snapshotsFound: 3, snapshotsStored: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://quota.zcode.test${QUOTA_PATH}`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(headersOf(calls[0]).Authorization).toBe(`Bearer ${FAKE_API_KEY}`);
    expect(headersOf(calls[0]).Accept).toBe("application/json");

    const stored = selectOfficialKeyUsage(db, { vendor: "zcode" });
    expect(stored).toHaveLength(3);
    expect(stored.map((entry) => entry.limitId)).toEqual([
      "TIME_LIMIT:5:1",
      "TOKENS_LIMIT:3:5",
      "TOKENS_LIMIT:6:1"
    ]);
    expect(stored.every((entry) => entry.source === "zcode-quota-api")).toBe(true);
    expect(stored.find((entry) => entry.limitId === "TOKENS_LIMIT:6:1")).toMatchObject({
      vendor: "zcode",
      source: "zcode-quota-api",
      limitName: "Weekly token limit",
      primary: {
        usedPercent: 7,
        windowMinutes: 10080,
        resetsAt: isoFromUnixMs(1792395000981)
      },
      secondary: null,
      credits: null,
      expiresAt: null,
      observedAt: NOW.toISOString()
    });
  });

  it("honors the config path and API base env vars when no option is passed", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-env-");
    const configPath = join(root, "config.json");
    await writeConfig(configPath, {
      "builtin:bigmodel-coding-plan": { options: { apiKey: FAKE_API_KEY } }
    });
    const previousPath = process.env.AGENT_METRICS_ZCODE_CONFIG_PATH;
    const previousBase = process.env.AGENT_METRICS_ZCODE_QUOTA_API_BASE;
    process.env.AGENT_METRICS_ZCODE_CONFIG_PATH = configPath;
    process.env.AGENT_METRICS_ZCODE_QUOTA_API_BASE = "https://env.zcode.test";

    try {
      const { calls, fetchImpl } = recordCalls();
      const result = await collectZCodeApiKeyUsage(createDb(), { fetchImpl, now: () => NOW });

      expect(result).toEqual({ snapshotsFound: 3, snapshotsStored: 3 });
      expect(calls[0]?.url).toBe(`https://env.zcode.test${QUOTA_PATH}`);
      expect(headersOf(calls[0]).Authorization).toBe(`Bearer ${FAKE_API_KEY}`);
    } finally {
      restoreEnv("AGENT_METRICS_ZCODE_CONFIG_PATH", previousPath);
      restoreEnv("AGENT_METRICS_ZCODE_QUOTA_API_BASE", previousBase);
    }
  });

  it("returns zero counts and warns when the envelope reports a failure", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-401-");
    const configPath = join(root, "config.json");
    await writeConfig(configPath, {
      "builtin:bigmodel-coding-plan": { options: { apiKey: FAKE_API_KEY } }
    });

    const { calls, fetchImpl } = recordCalls({ code: 401, msg: "令牌已过期或验证不正确", success: false });
    const log = { warn: vi.fn() };
    const db = createDb();
    const result = await collectZCodeApiKeyUsage(db, {
      configPath,
      apiBaseUrl: "https://quota.zcode.test",
      fetchImpl,
      now: () => NOW,
      log
    });

    expect(result).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(calls).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain("code 401");
    expect(selectOfficialKeyUsage(db, { vendor: "zcode" })).toEqual([]);
  });

  it("returns zero counts and warns when the request or the body fails", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-failures-");
    const configPath = join(root, "config.json");
    await writeConfig(configPath, {
      "builtin:bigmodel-coding-plan": { options: { apiKey: FAKE_API_KEY } }
    });
    const baseOptions = { configPath, apiBaseUrl: "https://quota.zcode.test", now: () => NOW };

    const networkLog = { warn: vi.fn() };
    const network = await collectZCodeApiKeyUsage(createDb(), {
      ...baseOptions,
      fetchImpl: vi.fn(async () => {
        throw new Error("network unreachable");
      }),
      log: networkLog
    });
    expect(network).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(networkLog.warn).toHaveBeenCalledTimes(1);

    const httpLog = { warn: vi.fn() };
    const httpFail = await collectZCodeApiKeyUsage(createDb(), {
      ...baseOptions,
      fetchImpl: recordCalls({ error: "boom" }, 500).fetchImpl,
      log: httpLog
    });
    expect(httpFail).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(httpLog.warn).toHaveBeenCalledTimes(1);

    const bodyLog = { warn: vi.fn() };
    const bodyFail = await collectZCodeApiKeyUsage(createDb(), {
      ...baseOptions,
      fetchImpl: vi.fn(async () => new Response("not json", { status: 200 })),
      log: bodyLog
    });
    expect(bodyFail).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(bodyLog.warn).toHaveBeenCalledTimes(1);
  });

  it("stores nothing without calling fetch when no coding-plan key is available", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-no-key-");
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });

    const scenarios: Array<{ name: string; configPath: string }> = [
      { name: "missing config", configPath: join(root, "missing.json") }
    ];

    const providerlessPath = join(root, "providerless.json");
    await writeFile(providerlessPath, JSON.stringify({ other: {} }));
    scenarios.push({ name: "provider missing", configPath: providerlessPath });

    const keylessPath = join(root, "keyless.json");
    await writeConfig(keylessPath, { "builtin:bigmodel-coding-plan": { options: { apiKey: "" } } });
    scenarios.push({ name: "apiKey empty", configPath: keylessPath });

    for (const scenario of scenarios) {
      const log = { warn: vi.fn() };
      const db = createDb();
      const result = await collectZCodeApiKeyUsage(db, {
        configPath: scenario.configPath,
        fetchImpl,
        now: () => NOW,
        log
      });

      expect(result, scenario.name).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
      expect(log.warn, scenario.name).toHaveBeenCalledTimes(1);
      expect(selectOfficialKeyUsage(db, { vendor: "zcode" }), scenario.name).toEqual([]);
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stores nothing when the account reports no limit", async () => {
    const root = await makeTempRoot("agent-metrics-zcode-api-empty-");
    const configPath = join(root, "config.json");
    await writeConfig(configPath, {
      "builtin:bigmodel-coding-plan": { options: { apiKey: FAKE_API_KEY } }
    });

    const { calls, fetchImpl } = recordCalls(limitsPayload([]));
    const log = { warn: vi.fn() };
    const db = createDb();
    const result = await collectZCodeApiKeyUsage(db, {
      configPath,
      apiBaseUrl: "https://quota.zcode.test",
      fetchImpl,
      now: () => NOW,
      log
    });

    expect(result).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(calls).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(selectOfficialKeyUsage(db, { vendor: "zcode" })).toEqual([]);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
