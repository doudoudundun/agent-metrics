import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip, createZstdDecompress } from "node:zlib";
import { once } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETAIL_RETENTION_INTERVAL_HOURS,
  DEFAULT_DETAIL_RETENTION_KEEP_MONTHS,
  cutoffFromKeepMonths,
  resolveDetailRetentionConfig,
  runDetailRetentionIfNeeded
} from "./detail-retention.js";
import type { DetailRetentionConfig } from "./detail-retention.js";

const requireFromRepo = createRequire(join(process.cwd(), "apps/core/package.json"));
const Database = requireFromRepo("better-sqlite3") as typeof import("better-sqlite3");

const NOW = new Date("2026-10-28T12:00:00.000Z");

/** 只建裁剪会碰到的列，够用即可；不引入完整 domain schema 以免测试跟着迁移走。 */
function createSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE normalized_events (
      event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE event_observations (
      event_id TEXT NOT NULL,
      adapter_instance_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (event_id, adapter_instance_id)
    );
    CREATE TABLE event_diagnostics (
      event_id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE tool_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE token_usage_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE assistant_responses (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE prompt_events (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE code_edits (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE usage_events (
      event_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      model_id TEXT,
      usage_measurement TEXT NOT NULL DEFAULT 'increment',
      displayed_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function seed(db: InstanceType<typeof Database>): void {
  const insertEvent = db.prepare(
    "INSERT INTO normalized_events (event_id, timestamp, event_type) VALUES (?, ?, ?)"
  );
  const insertObservation = db.prepare(
    "INSERT INTO event_observations (event_id, adapter_instance_id, observed_at) VALUES (?, 'a', ?)"
  );
  const insertDiagnostic = db.prepare(
    "INSERT INTO event_diagnostics (event_id, last_seen_at) VALUES (?, ?)"
  );
  // 旧明细：2026-05，早于保留窗口（裁剪点 2026-07-01）
  for (const type of ["tool.called", "tool.succeeded", "token.usage.recorded"]) {
    insertEvent.run(`old-detail:${type}`, "2026-05-10T01:00:00.000Z", type);
    insertObservation.run(`old-detail:${type}`, "2026-05-10T01:00:00.000Z");
    insertDiagnostic.run(`old-detail:${type}`, "2026-05-10T01:00:00.000Z");
  }
  // 骨架层：同样是 2026-05，但决定总量面板的计数，必须留着
  for (const type of ["prompt.submitted", "assistant.responded", "code.edit.applied"]) {
    insertEvent.run(`old-skeleton:${type}`, "2026-05-10T02:00:00.000Z", type);
  }
  // 保留窗口内的明细：2026-09
  insertEvent.run("recent-detail", "2026-09-10T01:00:00.000Z", "tool.called");
  insertObservation.run("recent-detail", "2026-09-10T01:00:00.000Z");

  const insertLegacy = (table: string, created: string) =>
    db.prepare(`INSERT INTO ${table} (id, created_at) VALUES (?, ?)`).run(table + created, created);
  for (const table of [
    "tool_events",
    "token_usage_events",
    "assistant_responses",
    "prompt_events",
    "code_edits"
  ]) {
    insertLegacy(table, "2026-05-10T03:00:00.000Z");
    insertLegacy(table, "2026-09-10T03:00:00.000Z");
  }

  // 事实层：2026-05 的用量事实，无论多老都不删
  db.prepare(
    `INSERT INTO usage_events (event_id, occurred_at, model_id, displayed_input_tokens, output_tokens)
     VALUES ('usage-old', '2026-05-10T04:00:00.000Z', 'm', 100, 10)`
  ).run();
}

async function readArchive(path: string): Promise<string[]> {
  const isZstd = path.endsWith(".zst");
  const source = Readable.from(await readFile(path));
  const decompressor = isZstd ? createZstdDecompress() : createGunzip();
  source.pipe(decompressor as never);
  const chunks: Buffer[] = [];
  decompressor.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(decompressor, "end");
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

async function makeConfig(root: string): Promise<DetailRetentionConfig> {
  return {
    enabled: true,
    keepMonths: DEFAULT_DETAIL_RETENTION_KEEP_MONTHS,
    intervalHours: DEFAULT_DETAIL_RETENTION_INTERVAL_HOURS,
    archiveDir: join(root, "archive"),
    statePath: join(root, "maintenance", "detail-retention.json"),
    dbPath: null
  };
}

function count(db: InstanceType<typeof Database>, sql: string): number {
  return (db.prepare<{ c: number }>(sql).get() as { c: number }).c;
}

describe("detail retention config", () => {
  it("falls back to documented defaults", () => {
    const config = resolveDetailRetentionConfig({ env: {}, eventLogPath: null, dbPath: null });
    expect(config.enabled).toBe(true);
    expect(config.keepMonths).toBe(DEFAULT_DETAIL_RETENTION_KEEP_MONTHS);
    expect(config.intervalHours).toBe(DEFAULT_DETAIL_RETENTION_INTERVAL_HOURS);
    expect(config.archiveDir).toBeNull();
    expect(config.statePath).toBeNull();
  });

  it("derives archive and state paths from the event log location", () => {
    const config = resolveDetailRetentionConfig({
      env: {},
      eventLogPath: join("/data", "agent-metrics-data", "data", "events", "events.jsonl"),
      dbPath: join("/data", "agent-metrics-data", "data", "sqlite", "metrics.sqlite")
    });
    expect(config.archiveDir).toBe(
      join("/data", "agent-metrics-data", "data", "events", "archive", "retention")
    );
    expect(config.statePath).toBe(
      join("/data", "agent-metrics-data", "maintenance", "detail-retention.json")
    );
  });

  it("reads overrides and rejects junk", () => {
    const config = resolveDetailRetentionConfig({
      env: {
        AGENT_METRICS_DETAIL_RETENTION_ENABLED: "off",
        AGENT_METRICS_DETAIL_RETENTION_KEEP_MONTHS: "6",
        AGENT_METRICS_DETAIL_RETENTION_INTERVAL_HOURS: "12"
      },
      eventLogPath: null
    });
    expect(config.enabled).toBe(false);
    expect(config.keepMonths).toBe(6);
    expect(config.intervalHours).toBe(12);

    const junk = resolveDetailRetentionConfig({
      env: { AGENT_METRICS_DETAIL_RETENTION_KEEP_MONTHS: "abc" },
      eventLogPath: null
    });
    expect(junk.keepMonths).toBe(DEFAULT_DETAIL_RETENTION_KEEP_MONTHS);
  });

  it("turns whole months into the first day of the window", () => {
    expect(cutoffFromKeepMonths(4, NOW)).toBe("2026-07-01");
    expect(cutoffFromKeepMonths(1, NOW)).toBe("2026-10-01");
    expect(cutoffFromKeepMonths(4, new Date("2026-01-15T00:00:00.000Z"))).toBe("2025-10-01");
  });
});

describe("detail retention run", () => {
  it("archives and deletes detail outside the window, keeping facts and skeleton", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-retention-"));
    const db = new Database(":memory:");
    createSchema(db);
    seed(db);
    const config = await makeConfig(root);

    const outcome = await runDetailRetentionIfNeeded({ db, config, now: NOW });
    expect(outcome.ran).toBe(true);

    // 明细层的旧行被删干净
    expect(count(db, "SELECT COUNT(*) AS c FROM normalized_events WHERE timestamp < '2026-07-01' AND event_type IN ('tool.called','tool.succeeded','token.usage.recorded')")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS c FROM tool_events WHERE created_at < '2026-07-01'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS c FROM prompt_events WHERE created_at < '2026-07-01'")).toBe(0);

    // 骨架层与保留窗口内的明细原样留着
    expect(count(db, "SELECT COUNT(*) AS c FROM normalized_events WHERE event_type IN ('prompt.submitted','assistant.responded','code.edit.applied')")).toBe(3);
    expect(count(db, "SELECT COUNT(*) AS c FROM normalized_events WHERE event_id = 'recent-detail'")).toBe(1);

    // 事实层一行都不能少
    expect(count(db, "SELECT COUNT(*) AS c FROM usage_events")).toBe(1);

    // 归档文件里能读回被删的行，且按表分别落盘
    const files = await readdir(config.archiveDir!);
    const eventArchive = files.find((name) => name.startsWith("normalized_events-before-2026-07-01"));
    expect(eventArchive).toBeDefined();
    const lines = await readArchive(join(config.archiveDir!, eventArchive!));
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line).event_type).sort()).toEqual([
      "token.usage.recorded",
      "tool.called",
      "tool.succeeded"
    ]);
  });

  it("records the run so a second call inside the interval is a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-retention-"));
    const db = new Database(":memory:");
    createSchema(db);
    seed(db);
    const config = await makeConfig(root);

    expect((await runDetailRetentionIfNeeded({ db, config, now: NOW })).ran).toBe(true);

    const second = await runDetailRetentionIfNeeded({ db, config, now: NOW });
    expect(second).toEqual({ ran: false, reason: "not-due" });

    const state = JSON.parse(await readFile(config.statePath!, "utf8")) as {
      lastRunAt: string;
      cutoff: string;
    };
    expect(state.lastRunAt).toBe(NOW.toISOString());
    expect(state.cutoff).toBe("2026-07-01T00:00:00");
  });

  it("runs again once the interval has passed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-retention-"));
    const db = new Database(":memory:");
    createSchema(db);
    seed(db);
    const config = await makeConfig(root);

    await runDetailRetentionIfNeeded({ db, config, now: NOW });
    // 再放一条刚过期的明细，26 小时后再跑应当处理掉它
    db.prepare(
      "INSERT INTO normalized_events (event_id, timestamp, event_type) VALUES ('later-detail', '2026-05-20T00:00:00.000Z', 'tool.failed')"
    ).run();
    const later = new Date(NOW.getTime() + 26 * 60 * 60 * 1000);
    const outcome = await runDetailRetentionIfNeeded({ db, config, now: later });
    expect(outcome.ran).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS c FROM normalized_events WHERE event_id = 'later-detail'")).toBe(0);
  });

  it("stamps the state file even when nothing is old enough", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-retention-"));
    const db = new Database(":memory:");
    createSchema(db);
    const config = await makeConfig(root);

    const outcome = await runDetailRetentionIfNeeded({ db, config, now: NOW });
    expect(outcome).toEqual({ ran: false, reason: "nothing-to-trim" });
    const state = JSON.parse(await readFile(config.statePath!, "utf8")) as { trimmedRows: number };
    expect(state.trimmedRows).toBe(0);
  });

  it("does nothing when disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-retention-"));
    const db = new Database(":memory:");
    createSchema(db);
    seed(db);
    const config = { ...(await makeConfig(root)), enabled: false };
    expect(await runDetailRetentionIfNeeded({ db, config, now: NOW })).toEqual({
      ran: false,
      reason: "disabled"
    });
    expect(count(db, "SELECT COUNT(*) AS c FROM tool_events")).toBe(2);
  });

  it("drops observations left behind by deleted parent events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-retention-"));
    const db = new Database(":memory:");
    createSchema(db);
    seed(db);
    // 观察记录时间在保留窗口内，但父事件已被删 —— 按孤行清掉
    db.prepare(
      "INSERT INTO event_observations (event_id, adapter_instance_id, observed_at) VALUES ('gone', 'a', '2026-09-01T00:00:00.000Z')"
    ).run();
    const config = await makeConfig(root);

    const outcome = await runDetailRetentionIfNeeded({ db, config, now: NOW });
    expect(outcome.ran).toBe(true);
    expect(count(db, "SELECT COUNT(*) AS c FROM event_observations WHERE event_id = 'gone'")).toBe(0);
  });
});
