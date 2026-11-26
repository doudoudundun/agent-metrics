import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectOfficialKeyUsage } from "./official-key-usage.js";
import {
  collectAntigravityKeyUsage,
  decodeGoKeyringSecret,
  parseAntigravityAvailableModels,
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
});
