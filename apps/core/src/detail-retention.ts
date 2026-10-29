import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join } from "node:path";
import type { Transform } from "node:stream";
import { createGzip } from "node:zlib";
import * as zlib from "node:zlib";
import type { SqliteDatabaseLike } from "./domain-types.js";

/**
 * 热库明细的自动裁剪。
 *
 * `scripts/retention.mjs` 是手动全量入口（可备份、可 VACUUM），这里做的是它的
 * 增量版：只删「已经过保留期的明细」，不备份、不 VACUUM，挂在 Core 启动和低频
 * 定时器上跑 —— 手动脚本没人会记得执行，库就会一路长回 3.7 GB。
 *
 * 两个入口的裁剪口径必须一致（下面 TARGETS / DETAIL_EVENT_TYPES 逐字对应
 * `scripts/retention.mjs`），改一边就要改另一边；`docs/manual/data-retention.md`
 * 记着这条约束。
 *
 * 保留三层：
 *   事实层全量   usage_events / tool_calls / sessions / domain_sessions
 *   骨架层全量   normalized_events 的 prompt.submitted / assistant.responded /
 *               code.edit.applied / session.*（总量面板的计数靠它们）
 *   明细层滚动   normalized_events 的 tool.* 与 token.usage.recorded，
 *               以及 event_observations / event_diagnostics / tool_events /
 *               token_usage_events / assistant_responses / prompt_events / code_edits
 */

/**
 * normalized_events 里只有这四类是「明细」。白名单写法：将来新增的事件类型
 * 默认落在保留侧，不会被静默删掉。
 */
const DETAIL_EVENT_TYPES = ["tool.called", "tool.succeeded", "tool.failed", "token.usage.recorded"];

const DETAIL_TYPE_LIST = DETAIL_EVENT_TYPES.map((type) => `'${type}'`).join(", ");

type RetentionTarget = { table: string; condition: string };

/** 被裁剪的表 → 「属于历史明细」的判定条件（只有一个 ? 绑定裁剪点） */
const TARGETS: readonly RetentionTarget[] = [
  {
    table: "normalized_events",
    condition: `timestamp < ? AND event_type IN (${DETAIL_TYPE_LIST})`
  },
  { table: "event_observations", condition: "observed_at < ?" },
  { table: "event_diagnostics", condition: "last_seen_at < ?" },
  { table: "tool_events", condition: "created_at < ?" },
  { table: "token_usage_events", condition: "created_at < ?" },
  { table: "assistant_responses", condition: "created_at < ?" },
  { table: "prompt_events", condition: "created_at < ?" },
  { table: "code_edits", condition: "created_at < ?" }
];

export const DEFAULT_DETAIL_RETENTION_KEEP_MONTHS = 4;
export const DEFAULT_DETAIL_RETENTION_INTERVAL_HOURS = 24;
/** 归档按 rowid keyset 分页，与脚本一致：LIMIT/OFFSET 在大表上是平方级慢。 */
const ARCHIVE_BATCH_SIZE = 2000;

export type DetailRetentionConfig = {
  enabled: boolean;
  keepMonths: number;
  intervalHours: number;
  /** 冷存档目录；为空表示不归档（只允许在测试里出现）。 */
  archiveDir: string | null;
  /** 记录上次执行时间的状态文件。 */
  statePath: string | null;
  /** 库文件路径，只用来在报告里算体积；缺省时跳过体积统计。 */
  dbPath: string | null;
};

export type DetailRetentionLogger = {
  info?(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
};

export type DetailRetentionArchive = {
  table: string;
  rows: number;
  bytes: number;
  path: string;
};

export type DetailRetentionOutcome =
  | { ran: false; reason: "disabled" | "not-due" | "nothing-to-trim" }
  | {
      ran: true;
      cutoff: string;
      archived: DetailRetentionArchive[];
      removed: Record<string, number>;
      sizeBefore: number | null;
    };

export function resolveDetailRetentionConfig(input: {
  env?: NodeJS.ProcessEnv;
  eventLogPath?: string | null;
  dbPath?: string | null;
}): DetailRetentionConfig {
  const env = input.env ?? process.env;
  // eventLogPath 形如 <dataRoot>/data/events/events.jsonl，向上三层才是数据根。
  const dataRoot = input.eventLogPath ? dirname(dirname(dirname(input.eventLogPath))) : null;
  return {
    enabled: readBoolean(env.AGENT_METRICS_DETAIL_RETENTION_ENABLED, true),
    keepMonths: readPositiveInteger(
      env.AGENT_METRICS_DETAIL_RETENTION_KEEP_MONTHS,
      DEFAULT_DETAIL_RETENTION_KEEP_MONTHS
    ),
    intervalHours: readPositiveInteger(
      env.AGENT_METRICS_DETAIL_RETENTION_INTERVAL_HOURS,
      DEFAULT_DETAIL_RETENTION_INTERVAL_HOURS
    ),
    archiveDir:
      dataRoot === null ? null : join(dataRoot, "data", "events", "archive", "retention"),
    statePath: dataRoot === null ? null : join(dataRoot, "maintenance", "detail-retention.json"),
    dbPath: input.dbPath ?? null
  };
}

/** 保留最近 n 个自然月（含本月）：n=4 且当前 2026-10 → 裁剪点 2026-07-01。 */
export function cutoffFromKeepMonths(months: number, now: Date = new Date()): string {
  const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  return shifted.toISOString().slice(0, 10);
}

/**
 * 按保留期裁剪明细。调用方负责保证「此刻没有别的写入者正处在长事务里」——
 * Core 里挂在启动早期和低频定时器上，都在 sync 之间的空档。
 */
export async function runDetailRetentionIfNeeded(input: {
  db: SqliteDatabaseLike;
  config: DetailRetentionConfig;
  logger?: DetailRetentionLogger;
  now?: Date;
}): Promise<DetailRetentionOutcome> {
  const { db, config, logger } = input;
  const now = input.now ?? new Date();
  if (!config.enabled) return { ran: false, reason: "disabled" };

  const lastRunAt = await readLastRunAt(config.statePath);
  if (lastRunAt !== null) {
    const elapsedHours = (now.getTime() - lastRunAt) / 3_600_000;
    if (elapsedHours < config.intervalHours) return { ran: false, reason: "not-due" };
  }

  const before = cutoffFromKeepMonths(config.keepMonths, now);
  const cutoff = `${before}T00:00:00`;
  const plan = TARGETS.map((target) => ({
    ...target,
    count: countRows(db, target, cutoff)
  })).filter((item) => item.count > 0);

  if (plan.length === 0) {
    // 没有可裁的行也记一次时间戳：否则每次启动都要把八张表各扫一遍。
    await writeState(config.statePath, { lastRunAt: now.toISOString(), cutoff, trimmedRows: 0 });
    return { ran: false, reason: "nothing-to-trim" };
  }

  const sizeBefore = await readFileSize(config.dbPath);
  const archived: DetailRetentionArchive[] = [];
  if (config.archiveDir !== null) {
    await mkdir(config.archiveDir, { recursive: true });
    for (const target of plan) {
      const path = join(
        config.archiveDir,
        `${target.table}-before-${before}.jsonl.${ARCHIVE_SUFFIX}`
      );
      const report = await archiveTable(db, target, cutoff, path);
      archived.push({ ...report, path });
    }
  }

  const removed = db.transaction(() => {
    const counts: Record<string, number> = {};
    for (const target of plan) {
      counts[target.table] = Number(
        (db.prepare(`DELETE FROM ${target.table} WHERE ${target.condition}`).run(cutoff) as {
          changes?: number;
        }).changes ?? 0
      );
    }
    // 归档口径按事件自身时间判定，会留下「父事件已删、观察记录按自己时间判活」
    // 的孤行。这里顺手清掉，口径和 purge-orphan-rows.mjs 一致。
    counts["event_observations(orphan)"] = Number(
      (db
        .prepare(
          `DELETE FROM event_observations
            WHERE NOT EXISTS (SELECT 1 FROM normalized_events n WHERE n.event_id = event_observations.event_id)`
        )
        .run() as { changes?: number }).changes ?? 0
    );
    counts["event_diagnostics(orphan)"] = Number(
      (db
        .prepare(
          `DELETE FROM event_diagnostics
            WHERE NOT EXISTS (SELECT 1 FROM normalized_events n WHERE n.event_id = event_diagnostics.event_id)`
        )
        .run() as { changes?: number }).changes ?? 0
    );
    return counts;
  })();

  // 不 VACUUM：它需要独占，且会把启动拖到分钟级。空间回收留给手动
  // `pnpm retention:apply --vacuum`（要先退出 App）。这里只把 WAL 落盘。
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // 还有别的连接在读时 checkpoint 会失败，不影响已经提交的删除。
  }

  const trimmedRows = plan.reduce((sum, item) => sum + item.count, 0);
  await writeState(config.statePath, {
    lastRunAt: now.toISOString(),
    cutoff,
    trimmedRows,
    archivedBytes: archived.reduce((sum, item) => sum + item.bytes, 0)
  });
  logger?.info?.(
    { cutoff, trimmedRows, archived: archived.length, sizeBefore },
    "trimmed historical detail outside the retention window"
  );
  return { ran: true, cutoff, archived, removed, sizeBefore };
}

function countRows(db: SqliteDatabaseLike, target: RetentionTarget, cutoff: string): number {
  const row = db
    .prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${target.table} WHERE ${target.condition}`)
    .get(cutoff);
  return row?.c ?? 0;
}

const ARCHIVE_SUFFIX = typeof (zlib as { createZstdCompress?: unknown }).createZstdCompress === "function" ? "zst" : "gz";

function createCompressor(): Transform {
  const withZstd = zlib as unknown as { createZstdCompress?: () => Transform };
  return typeof withZstd.createZstdCompress === "function"
    ? withZstd.createZstdCompress()!
    : (createGzip() as unknown as Transform);
}

async function writeChunk(compressor: Transform, text: string): Promise<void> {
  if (!compressor.write(text)) await once(compressor, "drain");
}

async function archiveTable(
  db: SqliteDatabaseLike,
  target: RetentionTarget,
  cutoff: string,
  archivePath: string
): Promise<{ table: string; rows: number; bytes: number }> {
  const compressor = createCompressor();
  const out = createWriteStream(archivePath);
  compressor.pipe(out);
  const select = db.prepare<Record<string, unknown> & { __rowid: number }>(
    `SELECT rowid AS __rowid, * FROM ${target.table}
      WHERE rowid > ? AND (${target.condition})
      ORDER BY rowid LIMIT ?`
  );
  let rows = 0;
  let lastRowid = 0;
  for (;;) {
    const batch = select.all(lastRowid, cutoff, ARCHIVE_BATCH_SIZE);
    if (batch.length === 0) break;
    lastRowid = batch[batch.length - 1]!.__rowid;
    const lines = batch.map((row) => {
      const { __rowid: _rowid, ...rest } = row;
      return `${JSON.stringify(rest)}\n`;
    });
    await writeChunk(compressor, lines.join(""));
    rows += batch.length;
  }
  compressor.end();
  await once(out, "finish");
  return { table: target.table, rows, bytes: (await stat(archivePath)).size };
}

async function readLastRunAt(statePath: string | null): Promise<number | null> {
  if (statePath === null) return null;
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { lastRunAt?: unknown };
    if (typeof parsed.lastRunAt !== "string") return null;
    const time = Date.parse(parsed.lastRunAt);
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}

async function writeState(statePath: string | null, value: Record<string, unknown>): Promise<void> {
  if (statePath === null) return;
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(value, null, 2), "utf8");
}

async function readFileSize(path: string | null): Promise<number | null> {
  if (path === null) return null;
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim();
  if (value === undefined || value === "") return fallback;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  return fallback;
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
