import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectOfficialKeyUsage } from "./official-key-usage.js";
import {
  collectKimicodeKeyUsage,
  parseKimicodeUsages,
  readKimicodeCredentials
} from "./official-key-usage-kimicode.js";
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

const OBSERVED_AT = "2026-10-12T00:00:00.000Z";
const NOW = new Date("2026-10-12T01:00:00.000Z");

function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

type AccountUsagePayload = {
  usages: Record<string, unknown>;
  boosterWallet: unknown;
};

/** The mocked `/usages` body: snake_case window keys plus a booster wallet. */
function accountUsagePayload(overrides: Partial<AccountUsagePayload> = {}): AccountUsagePayload {
  return {
    usages: {
      limit_5h: { used_ratio: 0.42, reset_time: 1791612611 },
      limit_7d: { used_ratio: 0.31, reset_time: 1792019956 },
      limit_month_total: { used_ratio: 0.12, reset_time: 1794612611 },
      limit_month_code: { used_ratio: 0.2, reset_time: 1794612611 }
    },
    boosterWallet: {
      balance: { type: "BOOSTER", amount: 12345678, amountLeft: 7654321 },
      monthlyChargeLimitEnabled: false,
      monthlyChargeLimit: { priceInCents: 5000, currency: "USD" },
      monthlyUsed: { priceInCents: 1234, currency: "USD" }
    },
    ...overrides
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function refreshResponse(accessToken: string): Response {
  return jsonResponse({ access_token: accessToken, refresh_token: "refresh-next", expires_in: 3600 });
}

async function writeCredentials(
  path: string,
  account: { accessToken: string; refreshToken?: string | null; expiresAt?: number | null }
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      access_token: account.accessToken,
      refresh_token: account.refreshToken ?? "refresh-1",
      expires_at: account.expiresAt ?? Math.floor(NOW.getTime() / 1000) + 3600
    })
  );
}

type RecordedCall = { url: string; init?: RequestInit };

function recordCalls(): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return url.includes("/api/oauth/token")
      ? refreshResponse("access-refreshed")
      : jsonResponse(accountUsagePayload());
  });
  return { calls, fetchImpl };
}

function authorizeHeaderOf(call: RecordedCall | undefined): string | undefined {
  const headers = (call?.init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization;
}

describe("parseKimicodeUsages", () => {
  it("maps every window key plus the booster wallet into snapshots", () => {
    const snapshots = parseKimicodeUsages(accountUsagePayload(), OBSERVED_AT);

    expect(snapshots).toHaveLength(5);
    expect(snapshots.map((entry) => entry.limitId)).toEqual([
      "limit_5h",
      "limit_7d",
      "limit_month_total",
      "limit_month_code",
      "booster-wallet"
    ]);
    expect(snapshots[0]).toMatchObject({
      vendor: "kimicode",
      source: "kimicode-api",
      limitId: "limit_5h",
      limitName: "5h limit",
      primary: {
        usedPercent: 42,
        windowMinutes: 300,
        resetsAt: isoFromUnixSeconds(1791612611)
      },
      secondary: null,
      credits: null,
      expiresAt: null,
      observedAt: OBSERVED_AT
    });
    expect(snapshots[1]).toMatchObject({
      limitName: "Weekly limit",
      primary: { usedPercent: 31, windowMinutes: 10080, resetsAt: isoFromUnixSeconds(1792019956) }
    });
    expect(snapshots[2]).toMatchObject({
      limitName: "Monthly total",
      primary: { usedPercent: 12, windowMinutes: 43200 }
    });
    expect(snapshots[3]).toMatchObject({
      limitName: "Monthly code",
      primary: { usedPercent: 20, windowMinutes: 43200 }
    });
    expect(snapshots[4]).toMatchObject({
      limitId: "booster-wallet",
      limitName: "Booster wallet",
      primary: null,
      secondary: null,
      credits: { hasCredits: true, unlimited: false }
    });
  });

  it("skips absent windows and treats a missing section as no snapshot", () => {
    const partial = parseKimicodeUsages(
      accountUsagePayload({
        usages: { limit_5h: { used_ratio: 0.42, reset_time: 1791612611 } },
        boosterWallet: null
      }),
      OBSERVED_AT
    );

    expect(partial).toHaveLength(1);
    expect(partial[0]?.limitId).toBe("limit_5h");

    expect(parseKimicodeUsages({ usages: null, boosterWallet: null }, OBSERVED_AT)).toEqual([]);
    expect(
      parseKimicodeUsages(
        { usages: { limit_5h: { reset_time: 1791612611 } }, boosterWallet: null },
        OBSERVED_AT
      )
    ).toEqual([]);
    expect(parseKimicodeUsages(undefined, OBSERVED_AT)).toEqual([]);
  });

  it("normalizes seconds, milliseconds, and ISO reset times", () => {
    const milliseconds = 1791612611000;
    const iso = "2026-10-10T09:30:11.000Z";
    const snapshots = parseKimicodeUsages(
      {
        usages: {
          limit_5h: { used_ratio: 0.5, reset_time: 1791612611 },
          limit_7d: { used_ratio: 0.5, reset_time: milliseconds },
          limit_month_total: { used_ratio: 0.5, reset_time: iso },
          limit_month_code: { used_ratio: 0.5 }
        }
      },
      OBSERVED_AT
    );

    expect(snapshots.map((entry) => entry.primary?.resetsAt)).toEqual([
      isoFromUnixSeconds(1791612611),
      isoFromUnixSeconds(1791612611),
      iso,
      null
    ]);
  });

  it("marks an empty booster balance as no credits", () => {
    const snapshots = parseKimicodeUsages(
      {
        usages: {},
        boosterWallet: {
          balance: { type: "BOOSTER", amount: 12345678, amountLeft: 0 },
          monthlyChargeLimitEnabled: false
        }
      },
      OBSERVED_AT
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.credits).toEqual({ hasCredits: false, unlimited: false });
  });
});

describe("readKimicodeCredentials", () => {
  it("reads the token fields and converts seconds to milliseconds", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-credentials-");
    const credentialsPath = join(root, "kimi-code.json");
    await writeCredentials(credentialsPath, { accessToken: "access-1", expiresAt: 1791612611 });

    const credentials = readKimicodeCredentials(credentialsPath);
    expect(credentials).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1791612611 * 1000
    });
  });

  it("returns null for missing, malformed, or token-less files", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-credentials-bad-");

    expect(readKimicodeCredentials(join(root, "missing.json"))).toBeNull();

    const brokenPath = join(root, "broken.json");
    await writeFile(brokenPath, "{not json");
    expect(readKimicodeCredentials(brokenPath)).toBeNull();

    const tokenlessPath = join(root, "tokenless.json");
    await writeFile(tokenlessPath, JSON.stringify({ refresh_token: "refresh-only" }));
    expect(readKimicodeCredentials(tokenlessPath)).toBeNull();
  });
});

describe("collectKimicodeKeyUsage", () => {
  it("calls the usage API with the stored token and stores the snapshots", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-collect-");
    const credentialsPath = join(root, "kimi-code.json");
    await writeCredentials(credentialsPath, { accessToken: "access-1" });

    const { calls, fetchImpl } = recordCalls();

    const db = createDb();
    const result = await collectKimicodeKeyUsage(db, {
      credentialsPath,
      apiBaseUrl: "https://api.kimicode.test/coding/v1",
      oauthHost: "https://auth.kimicode.test",
      fetchImpl,
      now: () => NOW
    });

    expect(result).toEqual({ snapshotsFound: 5, snapshotsStored: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.kimicode.test/coding/v1/usages");
    expect(authorizeHeaderOf(calls[0])).toBe("Bearer access-1");

    const stored = selectOfficialKeyUsage(db, { vendor: "kimicode" });
    expect(stored).toHaveLength(5);
    const window = stored.find((entry) => entry.limitId === "limit_5h");
    expect(window).toMatchObject({
      vendor: "kimicode",
      source: "kimicode-api",
      limitName: "5h limit",
      primary: {
        usedPercent: 42,
        windowMinutes: 300,
        resetsAt: isoFromUnixSeconds(1791612611)
      },
      observedAt: NOW.toISOString()
    });
    const booster = stored.find((entry) => entry.limitId === "booster-wallet");
    expect(booster).toMatchObject({
      primary: null,
      credits: { hasCredits: true, unlimited: false }
    });
  });

  it("returns zero counts without calling the API when credentials are missing", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-no-creds-");
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });

    const db = createDb();
    const result = await collectKimicodeKeyUsage(db, {
      credentialsPath: join(root, "missing.json"),
      fetchImpl,
      now: () => NOW
    });

    expect(result).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(selectOfficialKeyUsage(db, { vendor: "kimicode" })).toEqual([]);
  });

  it("refreshes an expired token before querying the usage endpoint", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-expired-");
    const credentialsPath = join(root, "kimi-code.json");
    await writeCredentials(credentialsPath, {
      accessToken: "access-old",
      expiresAt: Math.floor(NOW.getTime() / 1000) - 60
    });

    const { calls, fetchImpl } = recordCalls();
    const db = createDb();
    const result = await collectKimicodeKeyUsage(db, {
      credentialsPath,
      apiBaseUrl: "https://api.kimicode.test/coding/v1",
      oauthHost: "https://auth.kimicode.test",
      fetchImpl,
      now: () => NOW
    });

    expect(result.snapshotsStored).toBe(5);
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.kimicode.test/api/oauth/token",
      "https://api.kimicode.test/coding/v1/usages"
    ]);
    const refreshBody = new URLSearchParams(String(calls[0]?.init?.body));
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh-1");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(authorizeHeaderOf(calls[1])).toBe("Bearer access-refreshed");
  });

  it("refreshes and retries once when the usage endpoint answers 401", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-401-");
    const credentialsPath = join(root, "kimi-code.json");
    await writeCredentials(credentialsPath, { accessToken: "access-expired-server-side" });

    const calls: RecordedCall[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/api/oauth/token")) {
        return refreshResponse("access-after-refresh");
      }
      return (init?.headers as Record<string, string> | undefined)?.Authorization ===
        "Bearer access-after-refresh"
        ? jsonResponse(accountUsagePayload())
        : jsonResponse({ error: "unauthorized" }, 401);
    });

    const db = createDb();
    const result = await collectKimicodeKeyUsage(db, {
      credentialsPath,
      apiBaseUrl: "https://api.kimicode.test/coding/v1",
      oauthHost: "https://auth.kimicode.test",
      fetchImpl,
      now: () => NOW
    });

    expect(result.snapshotsStored).toBe(5);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.kimicode.test/coding/v1/usages",
      "https://auth.kimicode.test/api/oauth/token",
      "https://api.kimicode.test/coding/v1/usages"
    ]);
    expect(authorizeHeaderOf(calls[0])).toBe("Bearer access-expired-server-side");
    expect(authorizeHeaderOf(calls[2])).toBe("Bearer access-after-refresh");
    expect(selectOfficialKeyUsage(db, { vendor: "kimicode" })).toHaveLength(5);
  });

  it("returns zero counts when the token refresh fails", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-refresh-fail-");
    const credentialsPath = join(root, "kimi-code.json");
    await writeCredentials(credentialsPath, { accessToken: "access-expired-server-side" });

    const calls: RecordedCall[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/api/oauth/token")) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return jsonResponse({ error: "unauthorized" }, 401);
    });
    const log = { warn: vi.fn(), info: vi.fn() };

    const db = createDb();
    const result = await collectKimicodeKeyUsage(db, {
      credentialsPath,
      apiBaseUrl: "https://api.kimicode.test/coding/v1",
      oauthHost: "https://auth.kimicode.test",
      fetchImpl,
      now: () => NOW,
      log
    });

    expect(result).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.kimicode.test/coding/v1/usages",
      "https://auth.kimicode.test/api/oauth/token"
    ]);
    expect(log.warn).toHaveBeenCalled();
    expect(selectOfficialKeyUsage(db, { vendor: "kimicode" })).toEqual([]);
  });

  it("returns zero counts when the usage request fails", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-network-fail-");
    const credentialsPath = join(root, "kimi-code.json");
    await writeCredentials(credentialsPath, { accessToken: "access-1" });

    const fetchImpl = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const log = { warn: vi.fn(), info: vi.fn() };

    const db = createDb();
    const result = await collectKimicodeKeyUsage(db, {
      credentialsPath,
      apiBaseUrl: "https://api.kimicode.test/coding/v1",
      fetchImpl,
      now: () => NOW,
      log
    });

    expect(result).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(log.warn).toHaveBeenCalled();
  });

  it("honors AGENT_METRICS_KIMICODE_CREDENTIALS_PATH when no path is passed", async () => {
    const root = await makeTempRoot("agent-metrics-kimicode-env-");
    const credentialsPath = join(root, "kimi-code.json");
    await writeCredentials(credentialsPath, { accessToken: "access-env" });
    const previousPath = process.env.AGENT_METRICS_KIMICODE_CREDENTIALS_PATH;
    process.env.AGENT_METRICS_KIMICODE_CREDENTIALS_PATH = credentialsPath;

    try {
      const { calls, fetchImpl } = recordCalls();
      const db = createDb();
      const result = await collectKimicodeKeyUsage(db, {
        fetchImpl,
        now: () => NOW
      });

      expect(result.snapshotsStored).toBe(5);
      expect(authorizeHeaderOf(calls[0])).toBe("Bearer access-env");
    } finally {
      if (previousPath === undefined) {
        delete process.env.AGENT_METRICS_KIMICODE_CREDENTIALS_PATH;
      } else {
        process.env.AGENT_METRICS_KIMICODE_CREDENTIALS_PATH = previousPath;
      }
    }
  });
});