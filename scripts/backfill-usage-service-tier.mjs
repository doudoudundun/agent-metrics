#!/usr/bin/env node
/**
 * 回填历史用量的速度档（service tier）。
 *
 * 速度档是在 2026-10-22 才进入事件 schema 的（`usage_events.service_tier`），
 * 在此之前入库的用量一律是 NULL（按标准价计价）。但源 transcript 里其实一直
 * 记着真实速度档：
 *
 *   - Codex rollout：`event_msg / thread_settings_applied` 的
 *     `thread_settings.service_tier`（fast / priority / ultrafast / flex），
 *     按文件顺序向后生效，直到下一次 settings 事件。
 *   - Claude transcript：`message.usage.speed`（"fast" = 快速模式，"standard"
 *     表示未加速，也包含 Opus 4.6 静默回退成标准速度的情况）。
 *
 * 本脚本重新解析这些 transcript，按 (vendor, session_id, occurred_at) 精确匹配
 * 已有 usage_events 行，只把 service_tier IS NULL 的行补成观测到的非标准档位。
 * 不改动 token 计数、不动 semantic_fingerprint，也不写 events.jsonl / ledger。
 *
 * 用法：
 *   node scripts/backfill-usage-service-tier.mjs --db <path> [--apply]
 *        [--since-days 180] [--codex-root <dir>] [--claude-root <dir>]
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const dbPath = opt("--db");
if (!dbPath) {
  console.error("缺少 --db <metrics.sqlite 路径>");
  process.exit(1);
}
const apply = args.includes("--apply");
const sinceDays = Number(opt("--since-days", "180"));
const codexRoot = opt("--codex-root", join(homedir(), ".codex", "sessions"));
const claudeRoot = opt("--claude-root", join(homedir(), ".claude", "projects"));
const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

const TIER_VALUES = new Set(["fast", "priority", "ultrafast", "flex"]);

/** Map key: `${vendor}\0${sessionId}\0${timestamp}` → tier. */
const observations = new Map();

async function walkJsonl(root, onFile) {
  if (!existsSync(root)) {
    console.warn(`跳过不存在的目录: ${root}`);
    return;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(full, onFile);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const stats = statSync(full);
      if (stats.mtimeMs >= cutoffMs) {
        await onFile(full);
      }
    }
  }
}

function record(vendor, sessionId, timestamp, tier) {
  if (!sessionId || !timestamp || !TIER_VALUES.has(tier)) {
    return;
  }
  observations.set(`${vendor}\0${sessionId}\0${timestamp}`, tier);
}

async function scanCodexFile(file) {
  const sessionFromName = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? null;
  let sessionId = sessionFromName;
  let tier = null;
  const reader = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = row?.payload;
    if (row?.type === "session_meta" && payload?.id) {
      sessionId = String(payload.id);
      continue;
    }
    if (row?.type !== "event_msg" || !payload) continue;
    if (payload.type === "thread_settings_applied") {
      const raw = String(payload.thread_settings?.service_tier ?? payload.service_tier ?? "").toLowerCase();
      tier = TIER_VALUES.has(raw) ? raw : null;
      continue;
    }
    if (payload.type === "token_count") {
      record("codex", sessionId, row.timestamp, tier);
    }
  }
}

async function scanClaudeFile(file) {
  const reader = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.length === 0 || !line.includes('"speed"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const speed = row?.message?.usage?.speed;
    if (speed === "fast") {
      record("claude-code", row.sessionId, row.timestamp, "fast");
    }
  }
}

console.log(`扫描 Codex rollout: ${codexRoot} (近 ${sinceDays} 天)`);
await walkJsonl(codexRoot, scanCodexFile);
console.log(`扫描 Claude transcript: ${claudeRoot} (近 ${sinceDays} 天)`);
await walkJsonl(claudeRoot, scanClaudeFile);

const byVendor = new Map();
for (const key of observations.keys()) {
  const vendor = key.split("\0")[0];
  byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + 1);
}
console.log("观测到的非标准速度档:", Object.fromEntries(byVendor));

const db = new Database(dbPath);
const lookup = db.prepare(
  `SELECT event_id, raw_input_tokens, output_tokens FROM usage_events
   WHERE source_vendor = ? AND session_id = ? AND occurred_at = ? AND service_tier IS NULL`
);
const update = db.prepare("UPDATE usage_events SET service_tier = ? WHERE event_id = ?");

const planned = [];
for (const [key, tier] of observations) {
  const [vendor, sessionId, timestamp] = key.split("\0");
  for (const row of lookup.all(vendor, sessionId, timestamp)) {
    planned.push({ eventId: row.event_id, vendor, tier, tokens: row.raw_input_tokens + row.output_tokens });
  }
}

const affectedTokens = planned.reduce((sum, row) => sum + row.tokens, 0);
console.log(`可回填的行: ${planned.length}（涉及 ${affectedTokens.toLocaleString()} tokens）`);
for (const vendor of new Set(planned.map((row) => row.vendor))) {
  const rows = planned.filter((row) => row.vendor === vendor);
  const tiers = {};
  for (const row of rows) tiers[row.tier] = (tiers[row.tier] ?? 0) + 1;
  console.log(`  ${vendor}: ${rows.length} 行`, tiers);
}

if (!apply) {
  console.log("dry-run：未写库。加 --apply 执行。");
  db.close();
  process.exit(0);
}

const run = db.transaction((rows) => {
  for (const row of rows) update.run(row.tier, row.eventId);
});
run(planned);
console.log(`已回填 ${planned.length} 行。`);
db.close();
