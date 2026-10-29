#!/usr/bin/env node
/**
 * 清理「父记录已被删掉、自己还留着」的派生行。
 *
 *   node scripts/purge-orphan-rows.mjs --db <metrics.sqlite> [--apply]
 *
 * 背景：历史清洗脚本（purge-legacy-duplicates / purge-workbuddy-clone-duplicates）
 * 删了 normalized_events / sessions，却没删 event_observations、event_diagnostics
 * 这类派生表，于是同一个 event_id 在 observations 里留成孤行。它们不影响任何
 * 聚合数字，只占体积，并会让「observations 行数 > normalized_events 行数」
 * 这种异常看起来像数据问题。
 *
 * 清理范围（都要求父记录不存在才删）：
 *   event_observations    父：normalized_events(event_id)
 *   event_diagnostics     父：normalized_events(event_id)
 *   tool_events           父：sessions(session_id)
 *   tool_calls            父：sessions(session_id)
 *   token_usage_events    父：sessions(session_id)
 *   assistant_responses   父：sessions(session_id)
 *   prompt_events         父：sessions(session_id)
 *   code_edits            父：sessions(session_id)
 *
 * usage_events 的孤行**不删**：那 186 行是 legacy 清洗时故意保留的用量，
 * 属于真实发生过的 token 消耗，删掉会让总量对不上账。
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

const TARGETS = [
  {
    table: "event_observations",
    predicate: (alias) =>
      `NOT EXISTS (SELECT 1 FROM normalized_events n WHERE n.event_id = ${alias}.event_id)`
  },
  {
    table: "event_diagnostics",
    predicate: (alias) =>
      `NOT EXISTS (SELECT 1 FROM normalized_events n WHERE n.event_id = ${alias}.event_id)`
  },
  { table: "tool_events", predicate: (alias) => parentSessionMissing(alias) },
  { table: "tool_calls", predicate: (alias) => parentSessionMissing(alias) },
  { table: "token_usage_events", predicate: (alias) => parentSessionMissing(alias) },
  { table: "assistant_responses", predicate: (alias) => parentSessionMissing(alias) },
  { table: "prompt_events", predicate: (alias) => parentSessionMissing(alias) },
  { table: "code_edits", predicate: (alias) => parentSessionMissing(alias) }
];

function parentSessionMissing(alias) {
  return `NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = ${alias}.session_id)`;
}

function parseArgs(argv) {
  const options = { apply: false, backup: true, db: null, backupDir: "D:/backups/agent-metrics" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--no-backup") options.backup = false;
    else if (arg === "--db") options.db = argv[++index];
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/purge-orphan-rows.mjs --db <metrics.sqlite> [--apply] [--backup-dir <dir>]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.db) throw new Error("--db is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.db)) throw new Error(`database not found: ${options.db}`);

  const db = new Database(options.db);
  db.pragma("busy_timeout = 10000");

  const plan = TARGETS.map((target) => {
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM ${target.table} WHERE ${target.predicate(target.table)}`)
      .get().c;
    return { ...target, count };
  });

  let total = 0;
  for (const item of plan) {
    console.log(`${item.table.padEnd(22)} 孤行 ${String(item.count).padStart(7)}`);
    total += item.count;
  }
  console.log(`合计 ${total} 行`);

  if (!options.apply) {
    console.log("dry run: 加 --apply 才会删除");
    db.close();
    return;
  }
  if (total === 0) {
    db.close();
    return;
  }

  await mkdir(options.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(options.backupDir, `metrics-before-orphan-purge-${stamp}.sqlite`);
  if (options.backup) {
    console.log(`备份 -> ${backupPath}`);
    await db.backup(backupPath);
  } else {
    console.log("跳过备份（--no-backup）");
  }

  const removed = db.transaction(() => {
    const counts = [];
    for (const item of plan) {
      if (item.count === 0) continue;
      const info = db
        .prepare(`DELETE FROM ${item.table} WHERE ${item.predicate(item.table)}`)
        .run();
      counts.push([item.table, info.changes]);
    }
    return counts;
  })();
  for (const [table, count] of removed) console.log(`  ${table}: -${count}`);

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  console.log("done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
