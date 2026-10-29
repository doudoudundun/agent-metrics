#!/usr/bin/env node
/**
 * 历史明细裁剪机制。
 *
 * 目标：热库只保留「最近 N 个月」的事件明细，更早的明细压成冷存档后删除，
 * 库里继续保留可聚合的用量事实 —— token 数、模型名、供应商、会话、时间。
 *
 *   node scripts/retention.mjs                  # 默认 keep-months=4，dry run
 *   node scripts/retention.mjs --apply          # 归档 + 删除
 *   node scripts/retention.mjs --apply --vacuum # 归档 + 删除 + VACUUM 缩文件
 *   node scripts/retention.mjs --before 2026-07-01 --apply
 *
 * Options:
 *   --keep-months <n>      保留最近 n 个自然月（含本月）的明细，默认 4
 *   --before <YYYY-MM-DD>  直接指定裁剪点（优先于 --keep-months）
 *   --db <path>            库路径（默认按数据根解析）
 *   --archive-dir <dir>    冷存档目录（默认 <dataRoot>/events/archive/retention）
 *   --backup-dir <dir>     裁剪前全量备份目录（默认 D:/backups/agent-metrics）
 *   --no-backup            跳过全量备份
 *   --vacuum               删除后回收空间（需要没有其它连接在读库，通常要先退出 App）
 *
 * 保留分三层（同一份数据里，明细最重、事实最轻）：
 *   事实层  全量保留：usage_events（token/模型/供应商/会话/时间）、
 *           tool_calls（工具调用的计数与耗时，工具面板的唯一来源）、
 *           sessions + domain_sessions
 *   骨架层  全量保留：normalized_events 里 prompt.submitted /
 *           assistant.responded / code.edit.applied / session.* 这几类，
 *           总量面板的 prompt 数、响应数、代码编辑统计靠它们计数
 *   明细层  只留最近 N 个月：normalized_events 的 tool.called /
 *           tool.succeeded / tool.failed / token.usage.recorded，
 *           以及 event_observations / event_diagnostics / tool_events /
 *           token_usage_events / assistant_responses / prompt_events / code_edits
 *
 * 裁剪前每张表都归档成 <table>-before-<cutoff>.jsonl.zst（一行一条原始行，
 * 解压后可回灌），并写 retention-report-<cutoff>.json 与 retention.log。
 *
 * 裁剪后可见变化：裁剪点之前的会话点进去 timeline 为空，工具面板只统计
 * 裁剪点之后的窗口；总量、趋势、模型/供应商分布、会话数与每会话 token 不变。
 */

import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

/**
 * normalized_events 里只有这四类是「明细」：工具调用/结果与原始用量行。
 * 其余（prompt.submitted / assistant.responded / code.edit.applied /
 * session.*）是聚合口径的计数来源，必须留着 —— 删了总量面板的
 * prompt 数、响应数、代码编辑统计会掉到 0。白名单写法，将来新增类型默认保留。
 */
const DETAIL_EVENT_TYPES = ["tool.called", "tool.succeeded", "tool.failed", "token.usage.recorded"];

const DETAIL_TYPE_LIST = DETAIL_EVENT_TYPES.map((type) => `'${type}'`).join(", ");

/** 被裁剪的表 → 判定「属于历史明细」的条件（只有一个 ? 绑定裁剪点） */
const TARGETS = [
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

function parseArgs(argv) {
  const options = {
    apply: false,
    backup: true,
    vacuum: false,
    db: null,
    before: null,
    keepMonths: 4,
    archiveDir: null,
    backupDir: "D:/backups/agent-metrics"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--no-backup") options.backup = false;
    else if (arg === "--vacuum") options.vacuum = true;
    else if (arg === "--db") options.db = argv[++index];
    else if (arg === "--before") options.before = argv[++index];
    else if (arg === "--keep-months") options.keepMonths = Number.parseInt(argv[++index], 10);
    else if (arg === "--archive-dir") options.archiveDir = argv[++index];
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/retention.mjs [--keep-months 4 | --before YYYY-MM-DD] [--apply] [--vacuum] [--no-backup] [--db <path>]"
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.before !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(options.before)) {
    throw new Error("--before 必须是 YYYY-MM-DD");
  }
  if (options.before === null && !Number.isFinite(options.keepMonths)) {
    throw new Error("--keep-months 必须是整数");
  }
  return options;
}

/** 与 apps/core/src/server-runtime.ts 的 resolveCoreDataRoot 保持一致 */
function resolveDataRoot() {
  const explicit = process.env.AGENT_METRICS_DATA_ROOT?.trim();
  if (explicit) return resolve(explicit);
  if (process.env.APPDATA?.trim()) {
    return join(process.env.APPDATA.trim(), "Agent Metrics", "agent-metrics-data");
  }
  if (process.env.XDG_DATA_HOME?.trim()) {
    return join(process.env.XDG_DATA_HOME.trim(), "Agent Metrics", "agent-metrics-data");
  }
  if (process.env.HOME?.trim()) {
    return join(process.env.HOME.trim(), ".local", "share", "Agent Metrics", "agent-metrics-data");
  }
  return null;
}

/** 保留最近 n 个自然月（含本月）：n=4 且当前 2026-10 → 裁剪点 2026-07-01 */
function cutoffFromKeepMonths(months, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const shifted = new Date(Date.UTC(year, month - (months - 1), 1));
  return shifted.toISOString().slice(0, 10);
}

function openCompressedStream(path) {
  const compressor = ARCHIVE_SUFFIX === "zst" ? zlib.createZstdCompress() : zlib.createGzip();
  const out = createWriteStream(path);
  compressor.pipe(out);
  return { compressor, out };
}

const ARCHIVE_SUFFIX = typeof zlib.createZstdCompress === "function" ? "zst" : "gz";

async function writeChunk(compressor, text) {
  if (!compressor.write(text)) await once(compressor, "drain");
}

/**
 * 归档一张表：按 rowid keyset 分页（不能用 LIMIT/OFFSET，230k 行分 115 批
 * 时 OFFSET 会把每批都从头发扫一遍，实测 10 分钟才走完 15%）。
 */
async function archiveTable(db, target, cutoff, archivePath, total) {
  const { compressor, out } = openCompressedStream(archivePath);
  const select = db.prepare(
    `SELECT rowid AS __rowid, * FROM ${target.table}
      WHERE rowid > ? AND (${target.condition})
      ORDER BY rowid LIMIT ?`
  );
  const BATCH = 2000;
  let rows = 0;
  let lastRowid = 0;
  for (;;) {
    const batch = select.all(lastRowid, cutoff, BATCH);
    if (batch.length === 0) break;
    lastRowid = batch[batch.length - 1].__rowid;
    const lines = batch.map((row) => {
      const { __rowid: _rowid, ...rest } = row;
      return `${JSON.stringify(rest)}\n`;
    });
    await writeChunk(compressor, lines.join(""));
    rows += batch.length;
    if (rows % 20000 === 0) {
      console.log(`    ${target.table}: ${rows}/${total} 行`);
    }
  }
  compressor.end();
  await once(out, "finish");
  return { table: target.table, rows, bytes: (await stat(archivePath)).size };
}

function aggregateFingerprint(db) {
  const usage = db
    .prepare(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(displayed_input_tokens + output_tokens +
                           cache_read_input_tokens + cache_creation_input_tokens), 0) AS tokens
         FROM usage_events WHERE usage_measurement = 'increment'`
    )
    .get();
  const models = db.prepare("SELECT COUNT(DISTINCT model_id) AS c FROM usage_events").get().c;
  const sessions = db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c;
  return { usageRows: usage.rows, tokens: usage.tokens, models, sessions };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot();
  const dbPath =
    options.db ??
    process.env.AGENT_METRICS_DB_PATH ??
    (dataRoot === null ? null : join(dataRoot, "data", "sqlite", "metrics.sqlite"));
  if (dbPath === null || !existsSync(dbPath)) {
    console.error(`找不到用量库：${dbPath ?? "(无法解析数据根)"}`);
    console.error("用 --db <path> 或 AGENT_METRICS_DB_PATH 指定。");
    process.exit(2);
  }
  const before = options.before ?? cutoffFromKeepMonths(options.keepMonths);
  const cutoff = `${before}T00:00:00`;
  const archiveRoot =
    options.archiveDir ?? join(dataRoot ?? dirname(dbPath), "data", "events", "archive", "retention");

  const db = new Database(dbPath);
  db.pragma("busy_timeout = 15000");
  const sizeBefore = (await stat(dbPath)).size;
  const fingerprintBefore = aggregateFingerprint(db);

  console.log(`库：${dbPath}`);
  console.log(`当前体积：${(sizeBefore / 1073741824).toFixed(2)}GB`);
  console.log(`裁剪点：${cutoff}（早于它的明细先归档再删）`);

  const plan = TARGETS.map((target) => ({
    ...target,
    count: db.prepare(`SELECT COUNT(*) AS c FROM ${target.table} WHERE ${target.condition}`).get(cutoff).c
  }));
  for (const item of plan) console.log(`  ${item.table.padEnd(22)} ${String(item.count).padStart(8)} 行`);
  const totalRows = plan.reduce((sum, item) => sum + item.count, 0);
  console.log(`合计 ${totalRows} 行`);

  if (!options.apply) {
    console.log("dry run：加 --apply 才会归档并删除");
    db.close();
    return;
  }
  if (totalRows === 0) {
    console.log("没有需要裁剪的行");
    db.close();
    return;
  }

  if (!options.backup) {
    console.log("跳过全量备份（--no-backup）");
  } else {
    await mkdir(options.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupPath = join(options.backupDir, `metrics-before-retention-${stamp}.sqlite`);
    console.log(`全量备份 -> ${backupPath}`);
    await db.backup(backupPath);
  }

  await mkdir(archiveRoot, { recursive: true });
  const archived = [];
  for (const target of plan) {
    if (target.count === 0) continue;
    const path = join(archiveRoot, `${target.table}-before-${before}.jsonl.${ARCHIVE_SUFFIX}`);
    const report = await archiveTable(db, target, cutoff, path, target.count);
    archived.push({ ...report, path });
    console.log(`  归档 ${target.table}: ${report.rows} 行 -> ${(report.bytes / 1048576).toFixed(1)}MB`);
  }

  const removed = db.transaction(() => {
    const counts = [];
    for (const target of plan) {
      if (target.count === 0) continue;
      const info = db.prepare(`DELETE FROM ${target.table} WHERE ${target.condition}`).run(cutoff);
      counts.push([target.table, info.changes]);
    }
    // 归档口径按事件时间，会留下「父事件已删、观察记录还按自己的时间判活」的孤行
    const orphanObservations = db
      .prepare(
        `DELETE FROM event_observations
          WHERE NOT EXISTS (SELECT 1 FROM normalized_events n WHERE n.event_id = event_observations.event_id)`
      )
      .run().changes;
    const orphanDiagnostics = db
      .prepare(
        `DELETE FROM event_diagnostics
          WHERE NOT EXISTS (SELECT 1 FROM normalized_events n WHERE n.event_id = event_diagnostics.event_id)`
      )
      .run().changes;
    counts.push(["event_observations(孤行)", orphanObservations]);
    counts.push(["event_diagnostics(孤行)", orphanDiagnostics]);
    return counts;
  })();
  for (const [table, count] of removed) console.log(`  删除 ${table}: -${count}`);

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const fingerprintAfter = aggregateFingerprint(db);
  const sizeAfterDelete = (await stat(dbPath)).size;
  const freelist = db.pragma("freelist_count", { simple: true });

  let vacuumed = false;
  if (options.vacuum) {
    console.log("VACUUM 回收空间…");
    try {
      db.exec("VACUUM");
      vacuumed = true;
    } catch (error) {
      console.log(`VACUUM 失败（${error instanceof Error ? error.message : error}）：先退出 Agent Metrics 再重跑 --vacuum`);
    }
  }

  const sizeFinal = (await stat(dbPath)).size;
  const report = {
    generatedAt: new Date().toISOString(),
    dbPath,
    cutoff,
    sizeBefore,
    sizeAfterDelete,
    sizeFinal,
    freelistPages: freelist,
    vacuumed,
    archived,
    removed: Object.fromEntries(removed),
    aggregateBefore: fingerprintBefore,
    aggregateAfter: fingerprintAfter
  };
  const reportPath = join(archiveRoot, `retention-report-${before}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  await appendFile(
    join(archiveRoot, "retention.log"),
    `${report.generatedAt} cutoff=${cutoff} rows=${totalRows} size=${(sizeBefore / 1073741824).toFixed(2)}GB->${(sizeFinal / 1073741824).toFixed(2)}GB vacuum=${vacuumed}\n`,
    "utf8"
  );

  console.log("");
  console.log(`用量事实：${fingerprintBefore.usageRows} 行 / ${fingerprintBefore.tokens} tokens / ${fingerprintBefore.models} 模型 / ${fingerprintBefore.sessions} 会话`);
  // 只校验「有没有变少」：裁剪期间 App 若还开着，新事件会让计数变大，那不是丢失。
  const lost = [
    ["usage_events", fingerprintBefore.usageRows, fingerprintAfter.usageRows],
    ["tokens", fingerprintBefore.tokens, fingerprintAfter.tokens],
    ["模型数", fingerprintBefore.models, fingerprintAfter.models],
    ["会话数", fingerprintBefore.sessions, fingerprintAfter.sessions]
  ].filter(([, before, after]) => after < before);
  const grew = fingerprintAfter.usageRows - fingerprintBefore.usageRows;
  const verdict =
    lost.length === 0
      ? grew > 0
        ? `（无丢失 ✓，裁剪期间新写入 +${grew} 行）`
        : "（完全一致 ✓）"
      : `（丢失 ✗ ${lost.map(([name]) => name).join(",")}）`;
  console.log(`裁剪后：${fingerprintAfter.usageRows} 行 / ${fingerprintAfter.tokens} tokens / ${fingerprintAfter.models} 模型 / ${fingerprintAfter.sessions} 会话 ${verdict}`);
  console.log(`体积：${(sizeBefore / 1073741824).toFixed(2)}GB -> ${(sizeFinal / 1073741824).toFixed(2)}GB${vacuumed ? "" : `（空闲页 ${freelist}，约 ${(freelist * 4096 / 1048576).toFixed(0)}MB 待回收）`}`);
  console.log(`报告：${reportPath}`);
  db.close();
  if (lost.length > 0) process.exitCode = 3;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
