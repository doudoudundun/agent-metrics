#!/usr/bin/env node
/**
 * 清洗历史重复数据（非 WorkBuddy Switch 克隆类）。
 *
 * 1. legacy 双计：2026-07-20 的 000-adopt-legacy-baseline 把 v1 旧表回填成
 *    `legacy:` 事件，v2 管道后来又解析同一批 transcript，导致同一笔用量计两次。
 *    只删除「有 v2 完全相同记录」的 legacy 行，纯历史 legacy 数据保留。
 * 2. kimicode 克隆会话：session_5b352c69 与 session_ab0d6a45 存在完全相同的
 *    用量/响应/工具记录，只删 session_id + 自然键全等的那一份。
 * 3. workbuddy 残留：6c5bd20f / 88606b73 片段重叠，删后者的重复行。
 *
 * 用法：
 *   node scripts/purge-legacy-duplicates.mjs --db <path> [--apply] [--backup-dir <dir>]
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const apply = args.includes("--apply");
const dbPath = opt("--db");
const backupDir = opt("--backup-dir");
if (!dbPath) {
  console.error("缺少 --db <path>");
  process.exit(1);
}

const KEEP_KIMI = "session_ab0d6a45-82c8-4fd8-b097-be0b728cd231";
const DROP_KIMI = "session_5b352c69-ac3d-4019-a09b-5f9acf0e3b73";
const DROP_WB = "88606b73-b04f-485d-a3e7-0146f5a6dbb8";
const KEEP_WB = "6c5bd20f-5f9e-44de-9c91-b3aa986c3d25";

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

/** legacy 行：存在同 session/message/时间/token 的 v2 行 */
const LEGACY_MATCH = `
  event_id LIKE 'legacy:%'
  AND EXISTS (
    SELECT 1 FROM usage_events x
    WHERE x.event_id LIKE 'v2:%'
      AND x.session_id = usage_events.session_id
      AND x.message_id = usage_events.message_id
      AND x.occurred_at = usage_events.occurred_at
      AND x.raw_input_tokens = usage_events.raw_input_tokens
      AND x.output_tokens = usage_events.output_tokens
  )`;

const countLegacy = () =>
  db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(raw_input_tokens),0) inp, COALESCE(SUM(output_tokens),0) out
              FROM usage_events WHERE ${LEGACY_MATCH}`).get();

const legacyIds = () =>
  db.prepare(`SELECT event_id FROM usage_events WHERE ${LEGACY_MATCH}`).all().map((r) => r.event_id);

const kimiDup = (table, keys) => `
  session_id = '${DROP_KIMI}'
  AND EXISTS (
    SELECT 1 FROM ${table} k
    WHERE k.session_id = '${KEEP_KIMI}'
      AND ${keys.map((c) => `k.${c} = ${table}.${c}`).join(" AND ")}
  )`;

const countKimi = (table, keys) =>
  db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${kimiDup(table, keys)}`).get().n;

const wbDup = (table, keys) => `
  session_id = '${DROP_WB}'
  AND EXISTS (
    SELECT 1 FROM ${table} k
    WHERE k.session_id = '${KEEP_WB}'
      AND ${keys.map((c) => `k.${c} = ${table}.${c}`).join(" AND ")}
  )`;

const countWb = (table, keys) =>
  db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${wbDup(table, keys)}`).get().n;

const kimiRules = [
  ["usage_events", ["message_id", "occurred_at", "raw_input_tokens", "output_tokens", "cache_read_input_tokens"]],
  ["token_usage_events", ["message_id", "input_tokens", "output_tokens", "cache_read_input_tokens"]],
  ["assistant_responses", ["message_id", "response_chars", "created_at"]],
  ["tool_events", ["tool_call_id", "status", "created_at"]],
  ["tool_calls", ["tool_call_id"]],
  ["prompt_events", ["prompt_id", "prompt_chars", "created_at"]],
  ["code_edits", ["tool_name", "created_at", "insertions", "deletions"]]
];

const wbRules = [
  ["assistant_responses", ["message_id", "response_chars", "created_at"]],
  ["prompt_events", ["prompt_id", "prompt_chars", "created_at"]]
];

console.log("=== 待删统计 ===");
const legacy = countLegacy();
console.log(`legacy 与 v2 重叠的 usage 行: ${legacy.n}  input=${legacy.inp}  output=${legacy.out}`);

const legacyIdList = legacyIds();
const tokenNative = legacyIdList.map((id) => id.replace(/^legacy:token_usage_events:/u, ""));
const tokenDup = tokenNative.length
  ? db.prepare(
      `SELECT COUNT(*) n FROM token_usage_events WHERE event_id IN (${tokenNative.map(() => "?").join(",")})`
    ).get(...tokenNative).n
  : 0;
const normDup = legacyIdList.length
  ? db.prepare(
      `SELECT COUNT(*) n FROM normalized_events WHERE event_id IN (${legacyIdList.map(() => "?").join(",")})`
    ).get(...legacyIdList).n
  : 0;
console.log(`对应 token_usage_events 行: ${tokenDup}`);
console.log(`对应 normalized_events 行: ${normDup}`);

const kimiCounts = kimiRules.map(([t, k]) => [t, countKimi(t, k)]);
console.log("\nkimicode 克隆重复:");
for (const [t, n] of kimiCounts) console.log(`  ${t.padEnd(22)} ${n}`);

const wbCounts = wbRules.map(([t, k]) => [t, countWb(t, k)]);
console.log("\nworkbuddy 残留重复:");
for (const [t, n] of wbCounts) console.log(`  ${t.padEnd(22)} ${n}`);

if (!apply) {
  console.log("\n[dry-run] 未写入。加 --apply 执行。");
  db.close();
  process.exit(0);
}

// ---------- 备份 ----------
let backupPath = null;
if (backupDir) {
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  backupPath = join(backupDir, `metrics-before-legacy-purge-${stamp}.sqlite`);
  db.pragma("wal_checkpoint(TRUNCATE)");
  copyFileSync(dbPath, backupPath);
  console.log(`\n备份完成: ${backupPath}`);
}

// ---------- 执行 ----------
db.exec("CREATE TEMP TABLE IF NOT EXISTS tmp_purge_events(event_id TEXT PRIMARY KEY)");
db.exec("DELETE FROM tmp_purge_events");

const run = db.transaction(() => {
  const stmt = db.prepare("INSERT OR IGNORE INTO tmp_purge_events(event_id) SELECT event_id FROM usage_events WHERE " + LEGACY_MATCH);
  const inserted = stmt.run().changes;

  const deleted = {};
  deleted.usage_events = db
    .prepare("DELETE FROM usage_events WHERE event_id IN (SELECT event_id FROM tmp_purge_events)")
    .run().changes;
  deleted.token_usage_events = db
    .prepare(
      `DELETE FROM token_usage_events WHERE 'legacy:token_usage_events:' || event_id IN (SELECT event_id FROM tmp_purge_events)`
    )
    .run().changes;
  deleted.normalized_events = db
    .prepare("DELETE FROM normalized_events WHERE event_id IN (SELECT event_id FROM tmp_purge_events)")
    .run().changes;

  for (const [table, keys] of kimiRules) {
    deleted[`kimi.${table}`] = db.prepare(`DELETE FROM ${table} WHERE ${kimiDup(table, keys)}`).run().changes;
  }
  deleted[`kimi.normalized_events`] = db
    .prepare(
      `DELETE FROM normalized_events WHERE session_id = '${DROP_KIMI}' AND EXISTS (
         SELECT 1 FROM normalized_events k WHERE k.session_id = '${KEEP_KIMI}'
           AND k.type = normalized_events.type AND k.timestamp = normalized_events.timestamp)`
    )
    .run().changes;

  for (const [table, keys] of wbRules) {
    deleted[`wb.${table}`] = db.prepare(`DELETE FROM ${table} WHERE ${wbDup(table, keys)}`).run().changes;
  }
  deleted[`wb.normalized_events`] = db
    .prepare(
      `DELETE FROM normalized_events WHERE session_id = '${DROP_WB}' AND EXISTS (
         SELECT 1 FROM normalized_events k WHERE k.session_id = '${KEEP_WB}'
           AND k.type = normalized_events.type AND k.timestamp = normalized_events.timestamp)`
    )
    .run().changes;

  return { inserted, deleted };
});

const result = run();
console.log("\n=== 删除结果 ===");
console.log(result.deleted);
console.log("legacy 事件标记:", result.inserted);

db.exec("DROP TABLE IF EXISTS tmp_purge_events");
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
console.log("\n完成。");
