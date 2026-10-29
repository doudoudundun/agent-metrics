#!/usr/bin/env node
/**
 * 清理 usage_events 里「同一条用量被记两次」的行。
 *
 *   node scripts/purge-usage-duplicates.mjs --db <metrics.sqlite> [options]
 *
 * Options:
 *   --apply              执行删除（默认 dry run）
 *   --backup-dir <dir>   变更前备份目录（默认 D:/backups/agent-metrics）
 *   --source <vendor>    只处理某个 source_vendor（默认全部）
 *   --tolerance-ms <n>   同一次请求的时间容差（默认 2000）
 *
 * 判定口径（同一笔用量）：source_instance_id + session_id + message_id +
 * occurred_at 落在同一容差窗口内，且 raw/displayed/output/cache_read/cache_creation
 * 五个 token 数完全一致，provider_id 与 usage_measurement 也一致。
 * 时间容差是必须的：transcript 与 CLI 日志两条读取路径各自记时间戳，
 * 同一次请求会差几毫秒到几十毫秒（实测 4~44ms），按「完全相同」匹配会漏。
 * 满足条件时保留「证据更全」的一条（有 TTFT/decode → 有 credit →
 * 有 service_tier → created_at 更晚），其余从 usage_events、
 * normalized_events、event_observations 一并删除；legacy 镜像表
 * `token_usage_events` 里对应的那一行也要删，否则会留下孤儿行。
 *
 * 背景：事件日志按内容哈希生成 event_id，同一个 message 走两条读取路径
 * （transcript usage 行 / usage 索引）会得到两个 event_id，
 * 投影层的 reconcile* 只按 event_id 归并，因此这类配对会各插一行。
 * 日志里两行都在，所以重建库之后需要重新跑一次本脚本。
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

const TOKEN_COLUMNS = [
  "raw_input_tokens",
  "displayed_input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens"
];

function parseArgs(argv) {
  const options = {
    apply: false,
    db: null,
    backupDir: "D:/backups/agent-metrics",
    source: null,
    toleranceMs: 2000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--db") options.db = argv[++index];
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else if (arg === "--source") options.source = argv[++index];
    else if (arg === "--tolerance-ms") options.toleranceMs = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/purge-usage-duplicates.mjs --db <metrics.sqlite> [--source <vendor>] [--tolerance-ms <n>] [--apply] [--backup-dir <dir>]"
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.db) throw new Error("--db is required");
  if (!Number.isFinite(options.toleranceMs) || options.toleranceMs < 0) {
    throw new Error("--tolerance-ms must be a non-negative integer");
  }
  return options;
}

/** 证据完整度：数值越大越值得保留。 */
function evidenceScore(row) {
  let score = 0;
  if (row.first_token_latency_ms !== null) score += 4;
  if (row.decode_duration_ms !== null) score += 2;
  if (row.credit !== null) score += 8;
  if (row.service_tier !== null) score += 1;
  return score;
}

function findGroups(db, source, toleranceMs) {
  const filter = source === null ? "" : "WHERE source_vendor = ?";
  const params = source === null ? [] : [source];
  const candidates = db
    .prepare(
      `SELECT source_instance_id AS sourceInstanceId,
              session_id AS sessionId,
              message_id AS messageId,
              source_vendor AS vendor,
              provider_id AS providerId,
              usage_measurement AS measurement,
              ${TOKEN_COLUMNS.join(", ")},
              MIN(occurred_at) AS firstAt,
              COUNT(*) AS rowCount
         FROM usage_events
         ${filter}
        GROUP BY sourceInstanceId, sessionId, messageId, vendor,
                 provider_id, usage_measurement,
                 ${TOKEN_COLUMNS.join(", ")}
        HAVING rowCount > 1`
    )
    .all(...params);
  const rowsFor = db.prepare(
    `SELECT usage.event_id AS eventId,
            COALESCE(events.created_at, '') AS createdAt,
            usage.occurred_at AS occurredAt,
            usage.first_token_latency_ms, usage.decode_duration_ms,
            usage.credit, usage.service_tier, usage.usage_source,
            ${TOKEN_COLUMNS.map((column) => `usage.${column}`).join(", ")}
       FROM usage_events AS usage
       LEFT JOIN normalized_events AS events ON events.event_id = usage.event_id
      WHERE usage.source_instance_id = ? AND usage.session_id = ?
        AND usage.message_id = ? AND usage.source_vendor = ?
        AND usage.provider_id IS ? AND usage.usage_measurement = ?
        AND ${TOKEN_COLUMNS.map((column) => `usage.${column} = ?`).join(" AND ")}
      ORDER BY usage.occurred_at`
  );

  const groups = [];
  for (const candidate of candidates) {
    const rows = rowsFor.all(
      candidate.sourceInstanceId,
      candidate.sessionId,
      candidate.messageId,
      candidate.vendor,
      candidate.providerId,
      candidate.measurement,
      ...TOKEN_COLUMNS.map((column) => candidate[column])
    );
    // Same key, but the rows may belong to several requests: cluster them by
    // time so two retries of one message minutes apart stay separate.
    let cluster = [];
    const flush = () => {
      if (cluster.length > 1) {
        groups.push({ ...candidate, rows: cluster });
      }
      cluster = [];
    };
    for (const row of rows) {
      if (cluster.length > 0 && Date.parse(row.occurredAt) - Date.parse(cluster[0].occurredAt) > toleranceMs) {
        flush();
      }
      cluster.push(row);
    }
    flush();
  }
  return groups;
}

function pickKeeper(rows) {
  const ranked = [...rows].sort((left, right) => {
    const byEvidence = evidenceScore(right) - evidenceScore(left);
    if (byEvidence !== 0) return byEvidence;
    return String(right.createdAt).localeCompare(String(left.createdAt));
  });
  return ranked[0];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.db)) throw new Error(`database not found: ${options.db}`);

  const db = new Database(options.db);
  db.pragma("busy_timeout = 10000");

  const groups = findGroups(db, options.source, options.toleranceMs);
  console.log(`重复组: ${groups.length}`);

  const doomed = [];
  let removedRows = 0;
  let removedInput = 0;
  let removedOutput = 0;
  for (const group of groups) {
    const keeper = pickKeeper(group.rows);
    const extras = group.rows.filter((row) => row.eventId !== keeper.eventId);
    console.log(
      `  ${group.vendor} ${group.sessionId.slice(0, 8)} ${group.messageId.slice(0, 12)} @ ${group.firstAt}` +
        ` rows=${group.rows.length} keep=${keeper.eventId.slice(-12)}(${keeper.usage_source})` +
        ` drop=${extras.map((row) => row.eventId.slice(-12)).join(",")}`
    );
    for (const extra of extras) {
      doomed.push(extra.eventId);
      removedRows += 1;
      removedInput += extra.raw_input_tokens;
      removedOutput += extra.output_tokens;
    }
  }
  console.log(`待删除: ${removedRows} 行, raw_input=${removedInput}, output=${removedOutput}`);

  if (!options.apply) {
    console.log("dry run: 加 --apply 才会删除");
    db.close();
    return;
  }
  if (doomed.length === 0) {
    db.close();
    return;
  }

  await mkdir(options.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(options.backupDir, `metrics-before-usage-dedupe-${stamp}.sqlite`);
  console.log(`备份 -> ${backupPath}`);
  await db.backup(backupPath);

  const tableExists = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("token_usage_events").count > 0;
  const statements = [
    ["usage_events", "DELETE FROM usage_events WHERE event_id = ?"],
    ["normalized_events", "DELETE FROM normalized_events WHERE event_id = ?"],
    ["event_observations", "DELETE FROM event_observations WHERE event_id = ?"],
    ["event_diagnostics", "DELETE FROM event_diagnostics WHERE event_id = ?"],
    ["pending_usage_migrations", "DELETE FROM pending_usage_migrations WHERE event_id = ?"]
  ];
  if (tableExists) {
    // The legacy mirror keeps one row per usage row. Leaving the mirror row
    // behind makes it an orphan: session detail still shows the duplicate and
    // reconcileUsageDisposition sees a legacy row counted zero times.
    statements.push(["token_usage_events", "DELETE FROM token_usage_events WHERE event_id = ?"]);
  }
  const totals = db.transaction(() => {
    const counts = new Map();
    for (const eventId of doomed) {
      for (const [table, sql] of statements) {
        counts.set(table, (counts.get(table) ?? 0) + db.prepare(sql).run(eventId).changes);
      }
    }
    return counts;
  })();
  for (const [table, count] of totals) console.log(`  ${table}: -${count}`);

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  console.log("done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
