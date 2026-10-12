import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { KeyUsageResponseSchema } from "@agent-metrics/contracts";
import { buildApp } from "./app.js";
import {
  collectCodexKeyUsage,
  dedupeSnapshots,
  extractSnapshotsFromRolloutText,
  parseRateLimits,
  persistOfficialKeyUsage,
  selectOfficialKeyUsage,
  toKeyUsageResponse,
  type OfficialKeyUsageSnapshot
} from "./official-key-usage.js";
import type { SqliteDatabaseLike } from "./domain-types.js";

const tempRoots: string[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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

function rolloutLine(
  input: {
    timestamp?: string;
    limitId?: string;
    primaryPercent?: number;
    secondaryPercent?: number;
    primaryResetsAt?: number;
    secondaryResetsAt?: number;
  } = {}
): string {
  return JSON.stringify({
    timestamp: input.timestamp ?? "2026-10-10T01:50:16.475Z",
    ordinal: 3,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 51911253 } },
      rate_limits: {
        limit_id: input.limitId ?? "codex",
        limit_name: null,
        primary: {
          used_percent: input.primaryPercent ?? 20,
          window_minutes: 300,
          resets_at: input.primaryResetsAt ?? 1791612611
        },
        secondary: {
          used_percent: input.secondaryPercent ?? 33,
          window_minutes: 10080,
          resets_at: input.secondaryResetsAt ?? 1792019956
        },
        credits: { has_credits: false, unlimited: false, balance: "0" }
      }
    }
  });
}

function snapshot(
  input: Partial<OfficialKeyUsageSnapshot> & { observedAt: string }
): OfficialKeyUsageSnapshot {
  return {
    vendor: input.vendor ?? "codex",
    source: input.source ?? "codex-rollout",
    limitId: input.limitId === undefined ? "codex" : input.limitId,
    limitName: input.limitName === undefined ? null : input.limitName,
    primary:
      input.primary === undefined
        ? { usedPercent: 20, windowMinutes: 300, resetsAt: "2026-10-10T09:30:11.000Z" }
        : input.primary,
    secondary:
      input.secondary === undefined
        ? { usedPercent: 33, windowMinutes: 10080, resetsAt: "2026-10-15T01:19:16.000Z" }
        : input.secondary,
    credits: input.credits === undefined ? { hasCredits: false, unlimited: false } : input.credits,
    observedAt: input.observedAt
  };
}

describe("official key usage parsing", () => {
  it("parses codex rate_limits into window and credit fields", () => {
    expect(
      parseRateLimits({
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: 57.5, window_minutes: 300, resets_at: 1790685214 },
        secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1791055918 },
        credits: { has_credits: true, unlimited: false },
        plan_type: "plus"
      })
    ).toEqual({
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 57.5,
        windowMinutes: 300,
        resetsAt: new Date(1790685214 * 1000).toISOString()
      },
      secondary: {
        usedPercent: 61,
        windowMinutes: 10080,
        resetsAt: new Date(1791055918 * 1000).toISOString()
      },
      credits: { hasCredits: true, unlimited: false }
    });
  });

  it("ignores payloads without usable quota fields", () => {
    expect(parseRateLimits(undefined)).toBeNull();
    expect(parseRateLimits(null)).toBeNull();
    expect(parseRateLimits("codex")).toBeNull();
    expect(parseRateLimits({ limit_id: "codex" })).toBeNull();
    expect(parseRateLimits({ limit_id: "codex", primary: {} })).toBeNull();
  });

  it("extracts snapshots from rollout text and skips broken or unrelated lines", () => {
    const contents = [
      '{"timestamp":"2026-10-10T01:50:00.000Z","type":"session_meta","payload":{"id":"session-1"}}',
      '{"timestamp":"2026-10-10T01:50:01.000Z","type":"event_msg","payload":{"type":"task_started"}}',
      '{"timestamp":"2026-10-10T01:50:02.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{',
      "not json at all",
      '{"timestamp":"2026-10-10T01:50:03.000Z","type":"response_item","payload":{"note":"mentions \\"rate_limits\\" but is not one"}}',
      '{"timestamp":"2026-10-10T01:50:04.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{}}}',
      '{"timestamp":"not-a-date","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","limit_name":"primary plan","primary":{"used_percent":12,"window_minutes":300,"resets_at":1791612611},"secondary":null}}}',
      rolloutLine({ primaryPercent: 44, secondaryPercent: 51 })
    ].join("\n");

    const snapshots = extractSnapshotsFromRolloutText(contents, {
      observedAt: "2026-10-10T02:00:00.000Z"
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      vendor: "codex",
      source: "codex-rollout",
      limitId: "codex",
      limitName: "primary plan",
      primary: { usedPercent: 12, windowMinutes: 300 },
      secondary: null,
      // A record without a usable timestamp falls back to the scan timestamp.
      observedAt: "2026-10-10T02:00:00.000Z"
    });
    expect(snapshots[1]).toMatchObject({
      limitId: "codex",
      primary: { usedPercent: 44 },
      secondary: { usedPercent: 51 },
      observedAt: "2026-10-10T01:50:16.475Z"
    });
  });

  it("dedupes repeated snapshots of one quota window and keeps the newest", () => {
    const deduped = dedupeSnapshots([
      snapshot({ observedAt: "2026-10-10T01:00:00.000Z", primary: { usedPercent: 10, windowMinutes: 300, resetsAt: "2026-10-10T09:30:11.000Z" } }),
      snapshot({ observedAt: "2026-10-10T02:00:00.000Z", primary: { usedPercent: 45, windowMinutes: 300, resetsAt: "2026-10-10T09:30:11.000Z" } }),
      snapshot({
        observedAt: "2026-10-10T03:00:00.000Z",
        primary: { usedPercent: 1, windowMinutes: 300, resetsAt: "2026-10-10T14:30:11.000Z" }
      }),
      snapshot({
        observedAt: "2026-10-10T03:00:00.000Z",
        limitId: "codex-mini",
        primary: { usedPercent: 3, windowMinutes: 300, resetsAt: "2026-10-10T09:30:11.000Z" }
      })
    ]);

    expect(deduped).toHaveLength(3);
    expect(deduped.map((entry) => [entry.limitId, entry.primary?.usedPercent])).toEqual([
      ["codex", 1],
      ["codex", 45],
      ["codex-mini", 3]
    ]);
  });
});

describe("official key usage storage", () => {
  it("keeps the newest snapshot per window and never downgrades it", () => {
    const db = createDb();
    const older = snapshot({ observedAt: "2026-10-10T01:00:00.000Z" });
    const newer = snapshot({
      observedAt: "2026-10-10T02:00:00.000Z",
      primary: { usedPercent: 45, windowMinutes: 300, resetsAt: "2026-10-10T09:30:11.000Z" }
    });

    expect(persistOfficialKeyUsage(db, [newer, older], "2026-10-10T02:00:00.000Z")).toBe(2);
    expect(selectOfficialKeyUsage(db)).toHaveLength(1);
    expect(selectOfficialKeyUsage(db)[0]?.primary?.usedPercent).toBe(45);

    // A later scan that re-reads an old file must not overwrite fresher data.
    persistOfficialKeyUsage(db, [older], "2026-10-10T03:00:00.000Z");
    const rows = db.prepare<{ rowCount: number }>("SELECT COUNT(*) AS rowCount FROM official_key_usage").all();
    expect(rows[0]?.rowCount).toBe(1);

    const latest = selectOfficialKeyUsage(db)[0];
    expect(latest?.primary?.usedPercent).toBe(45);
    expect(latest?.observedAt).toBe("2026-10-10T02:00:00.000Z");
  });

  it("returns one latest entry per limit while keeping window history", () => {
    const db = createDb();
    persistOfficialKeyUsage(
      db,
      [
        snapshot({ observedAt: "2026-10-10T01:00:00.000Z" }),
        snapshot({
          observedAt: "2026-10-11T01:00:00.000Z",
          primary: { usedPercent: 72, windowMinutes: 300, resetsAt: "2026-10-11T09:30:11.000Z" },
          secondary: { usedPercent: 80, windowMinutes: 10080, resetsAt: "2026-10-15T01:19:16.000Z" }
        })
      ],
      "2026-10-11T01:00:00.000Z"
    );

    const selected = selectOfficialKeyUsage(db);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      vendor: "codex",
      source: "codex-rollout",
      limitId: "codex",
      credits: { hasCredits: false, unlimited: false },
      observedAt: "2026-10-11T01:00:00.000Z"
    });
    expect(selected[0]?.primary?.usedPercent).toBe(72);

    const rows = db.prepare<{ rowCount: number }>("SELECT COUNT(*) AS rowCount FROM official_key_usage").all();
    expect(rows[0]?.rowCount).toBe(2);
    expect(selectOfficialKeyUsage(db, { vendor: "cursor" })).toEqual([]);
  });

  it("returns an empty response when nothing has been collected", () => {
    const db = createDb();
    const response = toKeyUsageResponse(selectOfficialKeyUsage(db));

    expect(response).toEqual({ updatedAt: null, entries: [] });
    expect(KeyUsageResponseSchema.parse(response)).toEqual({ updatedAt: null, entries: [] });
  });

  it("keeps a null window when the source omitted it", () => {
    const db = createDb();
    persistOfficialKeyUsage(db, [
      snapshot({
        observedAt: "2026-10-10T02:00:00.000Z",
        secondary: null,
        credits: null
      })
    ]);

    const entry = selectOfficialKeyUsage(db)[0];
    expect(entry?.secondary).toBeNull();
    expect(entry?.credits).toBeNull();
    expect(entry?.primary?.usedPercent).toBe(20);
  });
});

describe("collectCodexKeyUsage", () => {
  it("scans rollout logs, dedupes windows, and stores the newest snapshot", async () => {
    const root = await makeTempRoot("agent-metrics-key-usage-");
    const dayDir = join(root, "2026", "10", "10");
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, "rollout-2026-10-10T01-50-00-01a1239b-1d29-7a72-94c8-bfd9b8e1ef17.jsonl"),
      [
        '{"timestamp":"2026-10-10T01:50:00.000Z","type":"session_meta","payload":{"id":"session-1"}}',
        rolloutLine({ primaryPercent: 20, secondaryPercent: 33 }),
        '{"timestamp":"2026-10-10T01:52:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex"',
        rolloutLine({
          timestamp: "2026-10-10T02:05:00.000Z",
          primaryPercent: 44,
          secondaryPercent: 41
        })
      ].join("\n")
    );
    await writeFile(join(dayDir, "notes.txt"), "not a rollout log");
    await writeFile(join(root, "empty.jsonl"), "\n\n");

    const db = createDb();
    const result = await collectCodexKeyUsage(db, { sessionsRoot: root });

    expect(result).toMatchObject({ filesScanned: 2, snapshotsFound: 2, snapshotsStored: 1 });
    expect(result.recordsRead).toBe(3);

    const collected = selectOfficialKeyUsage(db);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      vendor: "codex",
      source: "codex-rollout",
      limitId: "codex",
      observedAt: "2026-10-10T02:05:00.000Z",
      primary: {
        usedPercent: 44,
        windowMinutes: 300,
        resetsAt: new Date(1791612611 * 1000).toISOString()
      },
      secondary: {
        usedPercent: 41,
        windowMinutes: 10080,
        resetsAt: new Date(1792019956 * 1000).toISOString()
      },
      credits: { hasCredits: false, unlimited: false }
    });
  });

  it("returns zeroed counts when the sessions root does not exist", async () => {
    const root = await makeTempRoot("agent-metrics-key-usage-missing-");
    const db = createDb();

    await expect(
      collectCodexKeyUsage(db, { sessionsRoot: join(root, "missing") })
    ).resolves.toEqual({ filesScanned: 0, recordsRead: 0, snapshotsFound: 0, snapshotsStored: 0 });
    expect(selectOfficialKeyUsage(db)).toEqual([]);
  });

  it("honors AGENT_METRICS_CODEX_SESSIONS_ROOT when no root is passed", async () => {
    const root = await makeTempRoot("agent-metrics-key-usage-env-");
    const dayDir = join(root, "2026", "10", "10");
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, "rollout-2026-10-10T01-50-00-0142.jsonl"), rolloutLine());
    const previousRoot = process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT;
    process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT = root;

    try {
      const db = createDb();
      await expect(collectCodexKeyUsage(db)).resolves.toMatchObject({
        filesScanned: 1,
        snapshotsStored: 1
      });
      expect(selectOfficialKeyUsage(db)).toHaveLength(1);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT;
      } else {
        process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT = previousRoot;
      }
    }
  });
});

describe("GET /api/key-usage", () => {
  it("serves collected codex quota snapshots and an empty payload before collection", async () => {
    const root = await makeTempRoot("agent-metrics-key-usage-route-");
    const dayDir = join(root, "sessions", "2026", "10", "10");
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, "rollout-2026-10-10T01-50-00-01a1239b-1d29-7a72-94c8-bfd9b8e1ef17.jsonl"),
      rolloutLine({ primaryPercent: 44, secondaryPercent: 41 })
    );

    const app = buildApp({ dbPath: join(root, "metrics.sqlite") });
    apps.push(app);

    const empty = await app.inject({ method: "GET", url: "/api/key-usage" });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(empty.json()).toEqual({ updatedAt: null, entries: [] });

    await collectCodexKeyUsage(app.db as unknown as SqliteDatabaseLike, {
      sessionsRoot: join(root, "sessions")
    });

    const response = await app.inject({ method: "GET", url: "/api/key-usage" });
    expect(response.statusCode).toBe(200);
    const parsed = KeyUsageResponseSchema.parse(response.json());
    expect(parsed.updatedAt).toBe("2026-10-10T01:50:16.475Z");
    expect(parsed.entries).toEqual([
      {
        vendor: "codex",
        source: "codex-rollout",
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 44,
          windowMinutes: 300,
          resetsAt: new Date(1791612611 * 1000).toISOString()
        },
        secondary: {
          usedPercent: 41,
          windowMinutes: 10080,
          resetsAt: new Date(1792019956 * 1000).toISOString()
        },
        credits: { hasCredits: false, unlimited: false }
      }
    ]);

    const filtered = await app.inject({ method: "GET", url: "/api/key-usage?vendor=cursor" });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual({ updatedAt: null, entries: [] });
  });
});
