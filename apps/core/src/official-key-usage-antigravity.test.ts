import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistOfficialKeyUsage, selectOfficialKeyUsage } from "./official-key-usage.js";
import {
  ANTIGRAVITY_MANAGER_CACHE_SOURCE,
  collectAntigravityKeyUsage,
  decodeGoKeyringSecret,
  parseAntigravityAvailableModels,
  parseAntigravityManagerQuota,
  parseAntigravityQuotaSummary,
  readAntigravityCredentials
} from "./official-key-usage-antigravity.js";
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

const OBSERVED_AT = "2026-11-25T00:58:20.000Z";
const NOW = new Date(OBSERVED_AT);

function summaryPayload(): unknown {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2026-12-01T00:54:13Z",
            description: "You have used some of your weekly limit.",
            remainingFraction: 0.9084477
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            resetTime: "2026-11-25T05:49:25Z",
            description: "You have used some of your 5-hour limit.",
            remainingFraction: 0.9198667
          }
        ]
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2026-11-30T16:48:39Z",
            description: "You have used some of your weekly limit.",
            remainingFraction: 0.4416268
          },
          {
            bucketId: "3p-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            // Synthetic rolling horizon (now + 5h) with no description and 100% remaining.
            resetTime: "2026-11-25T05:58:19Z",
            remainingFraction: 1
          }
        ]
      }
    ]
  };
}

function availableModelsPayload(): unknown {
  return {
    models: {
      "gemini-4-neon": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        quotaInfo: { remainingFraction: 0.85, resetTime: "2026-11-25T05:00:00Z" },
        weeklyQuotaInfo: { remainingFraction: 0.9, resetTime: "2026-12-01T00:00:00Z" }
      },
      "gemini-3.8-flash": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        quotaInfo: { remainingFraction: 0.95, resetTime: "2026-11-25T05:00:00Z" }
      },
      "claude-opus-5-5": {
        modelProvider: "MODEL_PROVIDER_ANTHROPIC",
        quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-25T04:00:00Z" }
      }
    }
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function createProfileDir(
  providersRoot: string,
  account = "account-a",
  authMethod?: "oauth-personal" | "oauth-business"
): Promise<string> {
  const acpRoot = join(providersRoot, account, "antigravity-acp");
  await mkdir(join(acpRoot, "cache"), { recursive: true });
  if (authMethod !== undefined) {
    await writeFile(
      join(acpRoot, "cache", "acp-auth-state.json"),
      JSON.stringify({ methodId: authMethod })
    );
  }
  return acpRoot;
}

describe("decodeGoKeyringSecret", () => {
  it("decodes go-keyring base64, hex, and plain payloads", () => {
    const payload = JSON.stringify({ token: { access_token: "tok-1" } });
    expect(decodeGoKeyringSecret(`go-keyring-base64:${Buffer.from(payload).toString("base64")}`)).toBe(
      payload
    );
    expect(decodeGoKeyringSecret(`go-keyring-encoded:${Buffer.from(payload).toString("hex")}`)).toBe(
      payload
    );
    expect(decodeGoKeyringSecret(`  ${payload}  `)).toBe(payload);
  });
});

describe("parseAntigravityQuotaSummary", () => {
  it("maps grouped 5h and weekly buckets into snapshots and clears synthetic reset times", () => {
    const snapshots = parseAntigravityQuotaSummary(summaryPayload(), OBSERVED_AT, NOW.getTime());

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toEqual({
      vendor: "antigravity",
      source: "antigravity-quota-api",
      limitId: "gemini",
      limitName: "Gemini Models",
      primary: {
        usedPercent: 8.01,
        windowMinutes: 300,
        resetsAt: "2026-11-25T05:49:25.000Z"
      },
      secondary: {
        usedPercent: 9.16,
        windowMinutes: 10080,
        resetsAt: "2026-12-01T00:54:13.000Z"
      },
      credits: null,
      expiresAt: null,
      observedAt: OBSERVED_AT
    });

    expect(snapshots[1]).toEqual({
      vendor: "antigravity",
      source: "antigravity-quota-api",
      limitId: "3p",
      limitName: "Claude and GPT models",
      primary: {
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: null
      },
      secondary: {
        usedPercent: 55.84,
        windowMinutes: 10080,
        resetsAt: "2026-11-30T16:48:39.000Z"
      },
      credits: null,
      expiresAt: null,
      observedAt: OBSERVED_AT
    });
  });

  it("ignores disabled buckets and supports flat buckets arrays", () => {
    const snapshots = parseAntigravityQuotaSummary(
      {
        buckets: [
          {
            bucketId: "gemini-5h",
            window: "5h",
            remainingFraction: 0.5,
            resetTime: "2026-11-25T04:00:00Z"
          },
          {
            bucketId: "3p-5h",
            window: "5h",
            remainingFraction: 0,
            disabled: true
          }
        ]
      },
      OBSERVED_AT,
      NOW.getTime()
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.limitId).toBe("gemini");
    expect(snapshots[0]?.primary?.usedPercent).toBe(50);
  });

  it("returns empty array for missing or unreadable payloads", () => {
    expect(parseAntigravityQuotaSummary(undefined, OBSERVED_AT)).toEqual([]);
    expect(parseAntigravityQuotaSummary({ groups: [] }, OBSERVED_AT)).toEqual([]);
  });
});

describe("parseAntigravityAvailableModels", () => {
  it("aggregates the highest usedPercent per model provider family", () => {
    const snapshots = parseAntigravityAvailableModels(availableModelsPayload(), OBSERVED_AT);

    expect(snapshots).toEqual([
      {
        vendor: "antigravity",
        source: "antigravity-quota-api",
        limitId: "gemini",
        limitName: "Gemini Models",
        primary: {
          usedPercent: 15,
          windowMinutes: 0,
          resetsAt: "2026-11-25T05:00:00.000Z"
        },
        secondary: {
          usedPercent: 10,
          windowMinutes: 10080,
          resetsAt: "2026-12-01T00:00:00.000Z"
        },
        credits: null,
        expiresAt: null,
        observedAt: OBSERVED_AT
      },
      {
        vendor: "antigravity",
        source: "antigravity-quota-api",
        limitId: "claude",
        limitName: "Claude Models",
        primary: {
          usedPercent: 40,
          windowMinutes: 0,
          resetsAt: "2026-11-25T04:00:00.000Z"
        },
        secondary: null,
        credits: null,
        expiresAt: null,
        observedAt: OBSERVED_AT
      }
    ]);
  });
});

describe("readAntigravityCredentials", () => {
  it("reads acp_token.json and auth method from the profile directory", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-creds-");
    const acpRoot = await createProfileDir(providersRoot, "acct-1", "oauth-business");
    await writeFile(
      join(acpRoot, "acp_token.json"),
      JSON.stringify({
        client_id: "cid-1",
        client_secret: "csec-1",
        refresh_token: "rtok-1",
        project_id: "proj-1"
      })
    );

    const creds = await readAntigravityCredentials({ providersRoot });
    expect(creds).toEqual({
      kind: "acp-token",
      authMethod: "oauth-business",
      clientId: "cid-1",
      clientSecret: "csec-1",
      refreshToken: "rtok-1",
      projectId: "proj-1"
    });
  });

  it("reads antigravity-oauth-token when acp_token.json is absent", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-cli-creds-");
    const acpRoot = await createProfileDir(providersRoot, "acct-1", "oauth-personal");
    await writeFile(
      join(acpRoot, "antigravity-oauth-token"),
      JSON.stringify({
        token: {
          access_token: "access-cli-1",
          refresh_token: "refresh-cli-1",
          expiry: "2026-11-25T02:00:00Z"
        }
      })
    );

    const creds = await readAntigravityCredentials({ providersRoot });
    expect(creds).toEqual({
      kind: "cli-token",
      authMethod: "oauth-personal",
      accessToken: "access-cli-1",
      refreshToken: "refresh-cli-1",
      expiresAt: Date.parse("2026-11-25T02:00:00.000Z"),
      clientId: null,
      clientSecret: null,
      projectId: null
    });
  });

  it("does not touch the host keyring when providersRoot is isolated", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-isolated-");
    expect(await readAntigravityCredentials({ providersRoot })).toBeNull();
  });

  it("reads and decodes an injected keyring secret", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-keyring-");
    await createProfileDir(providersRoot, "acct-1", "oauth-personal");
    const encoded = `go-keyring-base64:${Buffer.from(
      JSON.stringify({
        token: { access_token: "keyring-tok", expiry: "2026-11-25T02:00:00Z" }
      })
    ).toString("base64")}`;

    const creds = await readAntigravityCredentials({
      providersRoot,
      readKeyringSecret: async () => encoded
    });
    expect(creds).toMatchObject({
      kind: "cli-token",
      authMethod: "oauth-personal",
      accessToken: "keyring-tok"
    });
  });

  it("falls back to standalone CLI home antigravity-oauth-token when profile credentials are absent", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-empty-prov-");
    const cliHome = await makeTempRoot("agent-metrics-agy-standalone-cli-");
    await mkdir(join(cliHome, "cache"), { recursive: true });
    await writeFile(
      join(cliHome, "cache", "acp-auth-state.json"),
      JSON.stringify({ methodId: "oauth-business" })
    );
    await writeFile(
      join(cliHome, "antigravity-oauth-token"),
      JSON.stringify({
        token: {
          access_token: "standalone-cli-tok",
          refresh_token: "standalone-refresh-tok",
          expiry: "2026-11-25T03:00:00Z"
        }
      })
    );

    const creds = await readAntigravityCredentials({ providersRoot, cliHome });
    expect(creds).toEqual({
      kind: "cli-token",
      authMethod: "oauth-business",
      accessToken: "standalone-cli-tok",
      refreshToken: "standalone-refresh-tok",
      expiresAt: Date.parse("2026-11-25T03:00:00.000Z"),
      clientId: null,
      clientSecret: null,
      projectId: null
    });
  });

  it("reads standalone CLI home token via AGENT_METRICS_ANTIGRAVITY_CLI_HOME", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-empty-prov-env-");
    const cliHome = await makeTempRoot("agent-metrics-agy-cli-env-");
    const previousCliHome = process.env.AGENT_METRICS_ANTIGRAVITY_CLI_HOME;
    process.env.AGENT_METRICS_ANTIGRAVITY_CLI_HOME = cliHome;
    try {
      await writeFile(
        join(cliHome, "antigravity-oauth-token"),
        JSON.stringify({
          token: {
            access_token: "env-cli-tok",
            expiry: "2026-11-25T04:00:00Z"
          }
        })
      );

      const creds = await readAntigravityCredentials({ providersRoot });
      expect(creds).toMatchObject({
        kind: "cli-token",
        authMethod: "oauth-personal",
        accessToken: "env-cli-tok"
      });
    } finally {
      if (previousCliHome === undefined) {
        delete process.env.AGENT_METRICS_ANTIGRAVITY_CLI_HOME;
      } else {
        process.env.AGENT_METRICS_ANTIGRAVITY_CLI_HOME = previousCliHome;
      }
    }
  });
});

describe("collectAntigravityKeyUsage", () => {
  it("queries daily endpoint first for oauth-personal and persists both groups", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-collect-");
    const acpRoot = await createProfileDir(providersRoot, "acct-1", "oauth-personal");
    await writeFile(
      join(acpRoot, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "access-1", expiry: "2026-11-25T02:00:00Z" }
      })
    );

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse(summaryPayload());
    });

    const db = createDb();
    const result = await collectAntigravityKeyUsage(db, {
      providersRoot,
      dailyEndpoint: "https://daily.agy.test",
      prodEndpoint: "https://prod.agy.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW
    });

    expect(result).toEqual({ snapshotsFound: 2, snapshotsStored: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://daily.agy.test/v1internal:retrieveUserQuotaSummary");
    expect((calls[0]?.init?.headers as Record<string, string>)?.Authorization).toBe("Bearer access-1");

    const stored = selectOfficialKeyUsage(db, { vendor: "antigravity" });
    expect(stored).toHaveLength(2);
    expect(stored.map((entry) => entry.limitName)).toEqual([
      "Claude and GPT models",
      "Gemini Models"
    ]);
  });

  it("refreshes acp_token.json and falls back to fetchAvailableModels when summary is empty", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-fallback-");
    const acpRoot = await createProfileDir(providersRoot, "acct-1", "oauth-business");
    await writeFile(
      join(acpRoot, "acp_token.json"),
      JSON.stringify({
        client_id: "cid-1",
        client_secret: "csec-1",
        refresh_token: "rtok-1",
        project_id: "proj-1"
      })
    );

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "https://oauth.agy.test/token") {
        return jsonResponse({ access_token: "fresh-access", expires_in: 3600 });
      }
      if (url.endsWith("retrieveUserQuotaSummary")) {
        return jsonResponse({});
      }
      if (url === "https://prod.agy.test/v1internal:fetchAvailableModels") {
        return jsonResponse(availableModelsPayload());
      }
      return jsonResponse({}, 404);
    });

    const db = createDb();
    const result = await collectAntigravityKeyUsage(db, {
      providersRoot,
      dailyEndpoint: "https://daily.agy.test",
      prodEndpoint: "https://prod.agy.test",
      oauthTokenUrl: "https://oauth.agy.test/token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW
    });

    expect(result).toEqual({ snapshotsFound: 2, snapshotsStored: 2 });
    expect(calls).toEqual([
      "https://oauth.agy.test/token",
      "https://prod.agy.test/v1internal:retrieveUserQuotaSummary",
      "https://daily.agy.test/v1internal:retrieveUserQuotaSummary",
      "https://prod.agy.test/v1internal:fetchAvailableModels"
    ]);
  });

  it("skips collection without calling fetch when saved token has expired", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-expired-");
    const acpRoot = await createProfileDir(providersRoot, "acct-1", "oauth-personal");
    await writeFile(
      join(acpRoot, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "old-access", expiry: "2026-11-25T00:50:00Z" }
      })
    );

    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    const db = createDb();

    const result = await collectAntigravityKeyUsage(db, {
      providersRoot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log
    });

    expect(result).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("prunes stale fallback rows when retrieveUserQuotaSummary succeeds", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-prune-");
    const acpRoot = await createProfileDir(providersRoot, "acct-1", "oauth-personal");
    await writeFile(
      join(acpRoot, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "access-1", expiry: "2026-11-25T02:00:00Z" }
      })
    );

    const db = createDb();
    persistOfficialKeyUsage(
      db,
      parseAntigravityAvailableModels(availableModelsPayload(), "2026-11-25T00:10:00.000Z"),
      "2026-11-25T00:10:00.000Z"
    );
    expect(selectOfficialKeyUsage(db, { vendor: "antigravity" }).map((entry) => entry.limitId)).toEqual([
      "claude",
      "gemini"
    ]);

    const fetchImpl = vi.fn(async () => jsonResponse(summaryPayload()));
    const result = await collectAntigravityKeyUsage(db, {
      providersRoot,
      dailyEndpoint: "https://daily.agy.test",
      prodEndpoint: "https://prod.agy.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW
    });

    expect(result).toEqual({ snapshotsFound: 2, snapshotsStored: 2 });
    const stored = selectOfficialKeyUsage(db, { vendor: "antigravity" });
    expect(stored.map((entry) => entry.limitName)).toEqual([
      "Claude and GPT models",
      "Gemini Models"
    ]);
  });

  it("preserves previously stored rows when quota endpoints return empty", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-empty-");
    const acpRoot = await createProfileDir(providersRoot, "acct-1", "oauth-personal");
    await writeFile(
      join(acpRoot, "antigravity-oauth-token"),
      JSON.stringify({
        token: { access_token: "access-1", expiry: "2026-11-25T02:00:00Z" }
      })
    );

    const db = createDb();
    persistOfficialKeyUsage(
      db,
      parseAntigravityQuotaSummary(summaryPayload(), "2026-11-25T00:10:00.000Z"),
      "2026-11-25T00:10:00.000Z"
    );

    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const result = await collectAntigravityKeyUsage(db, {
      providersRoot,
      dailyEndpoint: "https://daily.agy.test",
      prodEndpoint: "https://prod.agy.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      log: { warn: vi.fn(), info: vi.fn() }
    });

    expect(result).toEqual({ snapshotsFound: 0, snapshotsStored: 0 });
    expect(selectOfficialKeyUsage(db, { vendor: "antigravity" })).toHaveLength(2);
  });
});

async function writeManagerAccount(
  managerRoot: string,
  account: {
    id: string;
    accessToken?: string;
    expiryTimestampSec?: number;
    projectId?: string;
    quota?: unknown;
  }
): Promise<void> {
  await mkdir(join(managerRoot, "accounts"), { recursive: true });
  await writeFile(
    join(managerRoot, "accounts", `${account.id}.json`),
    JSON.stringify({
      id: account.id,
      ...(account.accessToken !== undefined
        ? {
            token: {
              access_token: account.accessToken,
              expiry_timestamp: account.expiryTimestampSec,
              project_id: account.projectId
            }
          }
        : {}),
      ...(account.quota !== undefined ? { quota: account.quota } : {})
    })
  );
}

describe("Antigravity Manager integration", () => {
  it("reads active agy/classic credentials from accounts.json ahead of T3 profiles", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-prov-mgr-");
    const acpRoot = await createProfileDir(providersRoot, "t3-acct", "oauth-personal");
    await writeFile(
      join(acpRoot, "antigravity-oauth-token"),
      JSON.stringify({ token: { access_token: "t3-token", expiry: "2026-11-25T05:00:00Z" } })
    );

    const managerRoot = await makeTempRoot("agent-metrics-agy-manager-");
    await writeManagerAccount(managerRoot, {
      id: "acct-agy",
      accessToken: "mgr-agy-token",
      expiryTimestampSec: Math.floor(Date.parse("2026-11-25T02:00:00Z") / 1000),
      projectId: "proj-agy"
    });
    await writeManagerAccount(managerRoot, {
      id: "acct-classic",
      accessToken: "mgr-classic-token",
      expiryTimestampSec: Math.floor(Date.parse("2026-11-25T03:00:00Z") / 1000),
      projectId: "proj-classic"
    });
    await writeFile(
      join(managerRoot, "accounts.json"),
      JSON.stringify({
        current_target_ide: "agy",
        current_account_id: "acct-classic",
        current_agy_account_id: "acct-agy",
        current_classic_account_id: "acct-classic"
      })
    );

    const agyCreds = await readAntigravityCredentials({ providersRoot, managerRoot });
    expect(agyCreds).toEqual({
      kind: "cli-token",
      authMethod: "oauth-personal",
      accessToken: "mgr-agy-token",
      refreshToken: null,
      expiresAt: Date.parse("2026-11-25T02:00:00.000Z"),
      clientId: null,
      clientSecret: null,
      projectId: "proj-agy"
    });

    await writeFile(
      join(managerRoot, "accounts.json"),
      JSON.stringify({
        current_target_ide: "classic",
        current_account_id: "acct-agy",
        current_agy_account_id: "acct-agy",
        current_classic_account_id: "acct-classic"
      })
    );

    const classicCreds = await readAntigravityCredentials({ providersRoot, managerRoot });
    expect(classicCreds).toMatchObject({
      accessToken: "mgr-classic-token",
      projectId: "proj-classic"
    });

    // When isolated via providersRoot without managerRoot, never touch ~/.antigravity_tools.
    const t3OnlyCreds = await readAntigravityCredentials({ providersRoot });
    expect(t3OnlyCreds).toMatchObject({ accessToken: "t3-token" });
  });

  it("prefers unexpired and newer T3 profile credentials across multiple account directories", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-multi-t3-");
    const acpA = await createProfileDir(providersRoot, "acct-a", "oauth-personal");
    const acpB = await createProfileDir(providersRoot, "acct-b", "oauth-personal");
    const acpC = await createProfileDir(providersRoot, "acct-c", "oauth-personal");

    // Alphabetically first directory has an expired token.
    await writeFile(
      join(acpA, "antigravity-oauth-token"),
      JSON.stringify({ token: { access_token: "expired-a", expiry: "2026-11-25T00:10:00Z" } })
    );
    // Older valid token in acct-b.
    const tokenPathB = join(acpB, "antigravity-oauth-token");
    await writeFile(
      tokenPathB,
      JSON.stringify({ token: { access_token: "valid-b", expiry: "2026-11-25T02:00:00Z" } })
    );
    await utimes(tokenPathB, new Date("2026-11-25T00:20:00Z"), new Date("2026-11-25T00:20:00Z"));
    // Newer valid token in acct-c.
    const tokenPathC = join(acpC, "antigravity-oauth-token");
    await writeFile(
      tokenPathC,
      JSON.stringify({ token: { access_token: "valid-c", expiry: "2026-11-25T02:00:00Z" } })
    );
    await utimes(tokenPathC, new Date("2026-11-25T00:50:00Z"), new Date("2026-11-25T00:50:00Z"));

    const creds = await readAntigravityCredentials({ providersRoot, now: () => NOW });
    expect(creds).toMatchObject({ accessToken: "valid-c" });
  });

  it("follows current_agy_account_id switches in Antigravity Manager", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-switch-prov-");
    const managerRoot = await makeTempRoot("agent-metrics-agy-switch-mgr-");
    const validExpSec = Math.floor(Date.parse("2026-11-25T02:00:00Z") / 1000);

    await writeManagerAccount(managerRoot, {
      id: "acct-1",
      accessToken: "token-1",
      expiryTimestampSec: validExpSec,
      projectId: "proj-consumers"
    });
    await writeManagerAccount(managerRoot, {
      id: "acct-2",
      accessToken: "token-2",
      expiryTimestampSec: validExpSec,
      projectId: "proj-consumers"
    });
    await writeFile(
      join(managerRoot, "accounts.json"),
      JSON.stringify({
        current_target_ide: "agy",
        current_account_id: "acct-1",
        current_agy_account_id: "acct-1"
      })
    );

    const seenTokens: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      seenTokens.push(auth);
      if (auth === "Bearer token-1") {
        return jsonResponse(summaryPayload());
      }
      return jsonResponse({
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-5h",
                window: "5h",
                remainingFraction: 0.99,
                resetTime: "2026-11-25T05:30:00Z",
                description: "active"
              }
            ]
          }
        ]
      });
    });

    const db = createDb();
    await collectAntigravityKeyUsage(db, {
      providersRoot,
      managerRoot,
      dailyEndpoint: "https://daily.agy.test",
      prodEndpoint: "https://prod.agy.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW
    });
    expect(selectOfficialKeyUsage(db, { vendor: "antigravity" })).toHaveLength(2);

    // Switch active account in Manager to acct-2.
    await writeFile(
      join(managerRoot, "accounts.json"),
      JSON.stringify({
        current_target_ide: "agy",
        current_account_id: "acct-2",
        current_agy_account_id: "acct-2"
      })
    );

    await collectAntigravityKeyUsage(db, {
      providersRoot,
      managerRoot,
      dailyEndpoint: "https://daily.agy.test",
      prodEndpoint: "https://prod.agy.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-11-25T00:59:00.000Z")
    });

    expect(seenTokens).toEqual(["Bearer token-1", "Bearer token-2"]);
    const afterSwitch = selectOfficialKeyUsage(db, { vendor: "antigravity" });
    expect(afterSwitch).toHaveLength(1);
    expect(afterSwitch[0]?.primary?.usedPercent).toBe(1);
  });

  it("falls back to Antigravity Manager cached quota_groups when token is expired or unauthorized", async () => {
    const providersRoot = await makeTempRoot("agent-metrics-agy-cache-prov-");
    const acpRoot = await createProfileDir(providersRoot, "t3-old", "oauth-personal");
    await writeFile(
      join(acpRoot, "antigravity-oauth-token"),
      JSON.stringify({ token: { access_token: "t3-stale", expiry: "2026-11-25T05:00:00Z" } })
    );

    const managerRoot = await makeTempRoot("agent-metrics-agy-cache-mgr-");
    const cachedQuota = {
      last_updated: Math.floor(NOW.getTime() / 1000),
      is_forbidden: false,
      quota_groups: [
        {
          display_name: "Gemini Models",
          buckets: [
            {
              bucket_id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0.75,
              reset_time: "2026-11-25T05:00:00Z",
              description: "cached 5h"
            },
            {
              bucket_id: "gemini-weekly",
              window: "weekly",
              remaining_fraction: 0.8,
              reset_time: "2026-12-01T00:00:00Z",
              description: "cached weekly"
            }
          ]
        }
      ]
    };

    // Case 1: expired Manager token skips fetch and uses cache (without falling back to t3-stale).
    await writeManagerAccount(managerRoot, {
      id: "acct-expired",
      accessToken: "mgr-expired",
      expiryTimestampSec: Math.floor(Date.parse("2026-11-25T00:10:00Z") / 1000),
      quota: cachedQuota
    });
    await writeFile(
      join(managerRoot, "accounts.json"),
      JSON.stringify({ current_agy_account_id: "acct-expired" })
    );

    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const db = createDb();
    const expiredResult = await collectAntigravityKeyUsage(db, {
      providersRoot,
      managerRoot,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW
    });

    expect(expiredResult).toEqual({ snapshotsFound: 1, snapshotsStored: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const stored = selectOfficialKeyUsage(db, { vendor: "antigravity" });
    expect(stored[0]).toMatchObject({
      source: ANTIGRAVITY_MANAGER_CACHE_SOURCE,
      limitId: "gemini",
      primary: { usedPercent: 25, windowMinutes: 300 },
      secondary: { usedPercent: 20, windowMinutes: 10080 }
    });

    // Case 2: valid Manager token returning 401 falls back to quota_groups cache.
    await writeManagerAccount(managerRoot, {
      id: "acct-401",
      accessToken: "mgr-401",
      expiryTimestampSec: Math.floor(Date.parse("2026-11-25T02:00:00Z") / 1000),
      quota: cachedQuota
    });
    await writeFile(
      join(managerRoot, "accounts.json"),
      JSON.stringify({ current_agy_account_id: "acct-401" })
    );

    const unauthorizedResult = await collectAntigravityKeyUsage(db, {
      providersRoot,
      managerRoot,
      dailyEndpoint: "https://daily.agy.test",
      prodEndpoint: "https://prod.agy.test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-11-25T00:59:30.000Z")
    });

    expect(unauthorizedResult).toEqual({ snapshotsFound: 1, snapshotsStored: 1 });
    expect(fetchImpl).toHaveBeenCalled();
    expect(parseAntigravityManagerQuota({ is_forbidden: true, quota_groups: cachedQuota.quota_groups })).toEqual([]);
  });
});
