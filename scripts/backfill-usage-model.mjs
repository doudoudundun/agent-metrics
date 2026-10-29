#!/usr/bin/env node
/**
 * 回补 Codex 用量行缺失的 model_id。
 *
 * 背景：这个适配器曾经只从 `~/.codex/logs_2.sqlite` 的 tracing 记录推断模型，
 * 而 Codex 并不是每次调用都写那行日志（agent 派生的子进程尤其常见）。结果是
 * 用量行有 token、没有模型，既不能定价，也会在面板上落进「未知模型」。
 *
 * 现在解析器优先读 rollout 里的 `turn_context.payload.model`，新数据不会再缺；
 * 这个脚本只处理改动之前已经入库的行：按用量事件的发生时间，取该会话里
 * 最近一条 `turn_context` 的模型，同时更新 normalized_events 的 payload 与
 * 语义指纹，保证将来重放不会被视为冲突。
 *
 * 用法：
 *   node scripts/backfill-usage-model.mjs                 # 预览
 *   node scripts/backfill-usage-model.mjs --apply         # 落库（先自动备份）
 *   node scripts/backfill-usage-model.mjs --db <path> --codex-root <dir>
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const apply = args.includes("--apply");

function resolveDbPath() {
  if (opt("--db")) return opt("--db");
  if (process.env.AGENT_METRICS_DB_PATH) return process.env.AGENT_METRICS_DB_PATH;
  const dataRoot =
    process.env.AGENT_METRICS_DATA_ROOT?.trim() ||
    (process.env.APPDATA ? join(process.env.APPDATA, "Agent Metrics", "agent-metrics-data") : null);
  return dataRoot ? join(dataRoot, "data", "sqlite", "metrics.sqlite") : null;
}

const dbPath = resolveDbPath();
if (dbPath === null || !existsSync(dbPath)) {
  console.error(`找不到用量库：${dbPath ?? "(无法解析)"}`);
  process.exit(2);
}
const codexRoot = opt("--codex-root") ?? process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT ?? join(homedir(), ".codex", "sessions");

const eventSchema = await import(
  pathToFileURL(join(repoRoot, "packages/event-schema/dist/index.js")).href
);

if (apply) {
  const backupPath = `${dbPath}.bak-model-backfill`;
  if (!existsSync(backupPath)) {
    copyFileSync(dbPath, backupPath);
    console.log(`已备份：${backupPath}`);
  }
}

const db = new Database(dbPath);

/** sessionId → rollout 文件路径 */
const rolloutIndex = new Map();
function indexRollouts(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      indexRollouts(fullPath);
      continue;
    }
    const match = /rollout-.*-([0-9a-f-]{36})\.jsonl(?:\.zst)?$/u.exec(entry.name);
    if (match !== null) {
      rolloutIndex.set(match[1], fullPath);
    }
  }
}
indexRollouts(codexRoot);
// Codex 把「已归档」的会话移到与 sessions 同级的 archived_sessions 目录，
// 只扫 sessions 会让这批会话全部报「找不到 rollout 文件」。
const archivedRoot = join(dirname(codexRoot), "archived_sessions");
if (existsSync(archivedRoot)) {
  indexRollouts(archivedRoot);
}

/**
 * 读出 rollout 文本。
 *
 * Codex 会把较早的 rollout 归档成 `.jsonl.zst`，只按 `.jsonl` 建索引会让整批
 * 老会话报「找不到 rollout 文件」—— 早期历史里缺失的 model_id 绝大多数就在
 * 这些压缩文件里。Node 22 自带 zstd 解压，不需要外部 zstd 命令。
 */
function readRolloutContents(rolloutPath) {
  let raw;
  try {
    raw = readFileSync(rolloutPath);
  } catch {
    return null;
  }
  if (!rolloutPath.endsWith(".zst")) {
    return raw.toString("utf8");
  }
  try {
    return zstdDecompressSync(raw).toString("utf8");
  } catch {
    return null;
  }
}

/** 读出某个 rollout 里的 turn_context 序列（时间升序）。 */
function readModelTimeline(rolloutPath) {
  const timeline = [];
  const contents = readRolloutContents(rolloutPath);
  if (contents === null) {
    return timeline;
  }
  for (const line of contents.split(/\r?\n/u)) {
    if (line.length === 0 || !line.includes('"turn_context"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type !== "turn_context") continue;
    const model = parsed?.payload?.model;
    const timestamp = parsed?.timestamp ?? parsed?.payload?.timestamp;
    if (typeof model !== "string" || typeof timestamp !== "string") continue;
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) continue;
    timeline.push({ ms, model });
  }
  return timeline.sort((left, right) => left.ms - right.ms);
}

function modelAt(timeline, occurredAt) {
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms) || timeline.length === 0) return null;
  let candidate = timeline[0].model;
  for (const entry of timeline) {
    if (entry.ms > ms) break;
    candidate = entry.model;
  }
  return candidate;
}

const pending = db
  .prepare(
    `SELECT event_id, session_id, occurred_at
     FROM usage_events
     WHERE usage_source = 'codex-rollout' AND (model_id IS NULL OR model_id = '')
     ORDER BY occurred_at`
  )
  .all();

if (pending.length === 0) {
  console.log("没有需要回补的 Codex 用量行。");
  db.close();
  process.exit(0);
}

const bySession = new Map();
for (const row of pending) {
  const list = bySession.get(row.session_id) ?? [];
  list.push(row);
  bySession.set(row.session_id, list);
}

const updates = [];
const unresolved = [];
for (const [sessionId, rows] of bySession) {
  const rolloutPath = rolloutIndex.get(sessionId);
  const timeline = rolloutPath ? readModelTimeline(rolloutPath) : [];
  if (timeline.length === 0) {
    unresolved.push({ sessionId, rows: rows.length, reason: rolloutPath ? "rollout 无 turn_context" : "找不到 rollout 文件" });
    continue;
  }
  for (const row of rows) {
    const model = modelAt(timeline, row.occurred_at);
    if (model === null) {
      unresolved.push({ sessionId, rows: 1, reason: "时间早于首个 turn_context" });
      continue;
    }
    updates.push({ ...row, model });
  }
}

const updateUsage = db.prepare("UPDATE usage_events SET model_id = ? WHERE event_id = ?");
const readEvent = db.prepare("SELECT payload_json FROM normalized_events WHERE event_id = ?");
const updateEvent = db.prepare(
  "UPDATE normalized_events SET payload_json = ?, semantic_fingerprint = ? WHERE event_id = ?"
);

if (apply) {
  const run = db.transaction(() => {
    for (const update of updates) {
      updateUsage.run(update.model, update.event_id);
      const stored = readEvent.get(update.event_id);
      if (stored === undefined) continue;
      const payload = JSON.parse(stored.payload_json);
      if (payload.model === update.model) continue;
      payload.model = update.model;
      updateEvent.run(
        JSON.stringify(payload),
        eventSchema.semanticFingerprint(payload),
        update.event_id
      );
    }
  });
  run();
}

console.log(`待回补 ${pending.length} 行：可确定模型 ${updates.length} 行${apply ? "（已写入）" : "（预览，加 --apply 落库）"}`);
for (const update of updates.slice(0, 10)) {
  console.log(`  ${update.occurred_at}  ${update.session_id.slice(0, 8)}…  → ${update.model}`);
}
if (updates.length > 10) console.log(`  … 其余 ${updates.length - 10} 行`);
for (const item of unresolved) {
  console.log(`  [跳过] ${item.sessionId.slice(0, 8)}… ${item.rows} 行：${item.reason}`);
}

db.close();
