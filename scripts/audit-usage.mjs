#!/usr/bin/env node
/**
 * 用量数据体检。
 *
 * 目的：数据源静默失效是本项目最容易复发的一类问题，而且症状永远表现为
 * 「面板数字看着有点怪」，不表现为报错。本脚本把已经踩过的坑固化成检查项，
 * 让问题在几分钟内暴露，而不是等面板对不上账再回头查。
 *
 * 检查项（每一项都对应一次真实事故）：
 *   semantics_mismatch     gross 行的 displayed_input_tokens 不等于
 *                          raw - cache_read → 投影把缓存算进了输入（面板输入虚高）
 *   cache_overflow         gross 行 cache_read + cache_creation > raw
 *                          → 缓存字段取自错误的记录（会把输入算成负数后夹到 0）
 *   cache_gap              某 gross 来源近 N 天「大输入且缓存为 0」的请求占比过高
 *                          → 缓存字段没采到（CodeBuddy cached_read_tokens 事故）
 *   source_stall           数据源目录近 24h 有写入，但该来源 24h 没有新事件
 *                          → 解析器/游标卡住，日志在长但没入库
 *   source_silent          数据源目录长期没有任何写入，而该来源历史上很活跃
 *                          → CLI 被加了不落盘的 flag（--ephemeral /
 *                          --no-session-persistence），日志根本没生成
 *   cross_source_duplicate 同 session+message+token 数、时间相差 2s 内被记了多次
 *                          → 双计（transcript 与 CLI 日志重叠）
 *   credit_gap             CodeBuddy 来源近 N 天 credit 缺失占比过高
 *   sync_run_health        sync_runs 最近的运行失败/中止
 *   event_log_gap          日志里已写入的用量在 usage_events 里缺失
 *                          → 重建库/游标越过文件末尾，历史事件没有回放
 *
 * 用法：
 *   node scripts/audit-usage.mjs                 # 体检默认数据根
 *   node scripts/audit-usage.mjs --days 14       # 调整回看窗口
 *   node scripts/audit-usage.mjs --json          # 机器可读输出
 *   node scripts/audit-usage.mjs --strict        # WARN 也返回非 0（给 CI 用）
 *   node scripts/audit-usage.mjs --db <path>     # 指定库
 *
 * 退出码：0 = 全部 PASS，1 = 有 WARN（仅 --strict），2 = 有 FAIL。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const asJson = args.includes("--json");
const strict = args.includes("--strict");
const days = Number.parseInt(opt("--days", "7"), 10) || 7;

// ---------------------------------------------------------------------------
// 数据根：与 apps/core/src/server-runtime.ts 的 resolveCoreDataRoot 保持一致
// ---------------------------------------------------------------------------

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

const dataRoot = resolveDataRoot();
const dbPath =
  opt("--db") ??
  process.env.AGENT_METRICS_DB_PATH ??
  (dataRoot ? join(dataRoot, "data", "sqlite", "metrics.sqlite") : null);

if (dbPath === null || !existsSync(dbPath)) {
  console.error(`找不到用量库：${dbPath ?? "(无法解析数据根)"}`);
  console.error("用 --db <path> 或 AGENT_METRICS_DB_PATH 指定。");
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// ---------------------------------------------------------------------------
// 检查项
// ---------------------------------------------------------------------------

const ISO_CUTOFF = new Date(Date.now() - days * 86_400_000).toISOString();
const ISO_DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();

/**
 * 每个来源对应的「数据源还在产生内容」探针。目录内有文件 mtime 晚于阈值，
 * 说明该 CLI 确实在跑；此时库里没有新事件就是采集中断。
 *
 * 这里只放能从代码里确定、且不依赖用户配置的路径；env 覆盖和用户自定义根
 * 不参与探测，缺探针的来源跳过 source_stall 检查而不是误报。
 */
const SOURCE_PROBES = [
  // 探针必须指向适配器真正读取的子目录：CLI 的 home 里还有配置、缓存、日志等
  // 每天都在变的文件，拿 home 当探针会把「配置被改」误判成「有调用没入库」。
  { source: "codebuddy-log", adapter: "codebuddy-cli-log", roots: [join(homedir(), ".codebuddy", "logs")] },
  {
    source: "workbuddy-usage",
    adapter: "workbuddy-jsonl",
    roots: [join(homedir(), ".workbuddy", "projects"), join(homedir(), ".codebuddy", "projects")]
  },
  { source: "codex-rollout", adapter: "codex-rollout", roots: [join(homedir(), ".codex", "sessions")] },
  { source: "kimicode-usage", adapter: "kimicode", roots: [join(homedir(), ".kimi-code", "sessions")] },
  {
    source: "dsh-usage",
    adapter: "dsh",
    roots: [join(homedir(), ".dsh", "sessions")],
    // dsh 自己维护按天聚合的用量账本，直接读它的最后一天最准：会话文件
    // 会被归档/重新压缩而更新 mtime，但没有模型调用时账本不会新增日期。
    latestActivity: () => {
      const ledgerPath = join(homedir(), ".dsh", "dsh-usage", "usage-ledger.json");
      try {
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
        const lastDay = Object.keys(ledger?.days ?? {}).sort().pop();
        if (typeof lastDay === "string") {
          const dayEnd = Date.parse(`${lastDay}T23:59:59Z`);
          if (!Number.isNaN(dayEnd)) return dayEnd;
        }
      } catch {
        // 账本缺失或格式变了，退回文件 mtime。
      }
      return newestMtime([join(homedir(), ".dsh", "sessions")], 2_000);
    }
  }
];

const findings = [];
const add = (level, check, summary, detail) => findings.push({ level, check, summary, detail });
/** 观察项：值得写进报告，但不代表异常，不参与 PASS/WARN/FAIL 判定。 */
const observations = [];
const observe = (label, text) => observations.push({ label, text });

const scalar = (sql, ...params) => db.prepare(sql).pluck().get(...params);
const rows = (sql, ...params) => db.prepare(sql).all(...params);

// 1. gross 语义下 displayed 必须等于 raw - cache_read
const semanticsMismatch = scalar(
  `SELECT COUNT(*) FROM usage_events
   WHERE input_token_semantics = 'gross'
     AND displayed_input_tokens <> raw_input_tokens - cache_read_input_tokens`
);
if (semanticsMismatch > 0) {
  add(
    "FAIL",
    "semantics_mismatch",
    `${semanticsMismatch} 行 gross 输入的 displayed 与 raw-cache 不一致`,
    "投影把缓存读算进了输入，面板输入会虚高。检查投影的 displayed_input_tokens 计算是否绕过 displayedInputTokens()。"
  );
}

// 2. gross 语义下缓存不能超过输入
const cacheOverflow = scalar(
  `SELECT COUNT(*) FROM usage_events
   WHERE input_token_semantics = 'gross'
     AND cache_read_input_tokens + cache_creation_input_tokens > raw_input_tokens`
);
if (cacheOverflow > 0) {
  add(
    "FAIL",
    "cache_overflow",
    `${cacheOverflow} 行 gross 输入的缓存量超过输入量`,
    "缓存字段大概率取自另一条记录。检查 adapter 的字段名与配对条件。"
  );
}

// 3. 缓存缺口：大输入却完全没有缓存读数
const cacheGap = rows(
  `SELECT usage_source, COUNT(*) AS total,
          SUM(CASE WHEN cache_read_input_tokens = 0 AND raw_input_tokens >= 50000 THEN 1 ELSE 0 END) AS gap,
          SUM(CASE WHEN cache_read_input_tokens = 0 AND raw_input_tokens >= 50000 THEN raw_input_tokens ELSE 0 END) AS gap_tokens
   FROM usage_events
   WHERE occurred_at >= ? AND input_token_semantics = 'gross'
   GROUP BY usage_source
   HAVING gap > 0
   ORDER BY gap_tokens DESC`,
  ISO_CUTOFF
);
for (const row of cacheGap) {
  const ratio = row.gap / row.total;
  // 会话首个请求没有缓存是正常的，只有占比明显偏高才值得怀疑。
  if (ratio < 0.2) continue;
  add(
    "WARN",
    "cache_gap",
    `${row.usage_source} 近 ${days} 天有 ${row.gap}/${row.total} 次大输入请求没有缓存读数（${Math.round(ratio * 100)}%）`,
    `涉及 ${row.gap_tokens.toLocaleString("en-US")} 毛输入 token。若该来源本应报缓存，检查解析字段名与配对方式。`
  );
}

// 4/5. 采集断流与静默
const sourceActivity = new Map(
  rows(
    `SELECT usage_source, COUNT(*) AS total, MAX(occurred_at) AS last_at,
            SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS recent
     FROM usage_events GROUP BY usage_source`,
    ISO_DAY_AGO
  ).map((row) => [row.usage_source, row])
);

const lastSuccess = rows(
  `SELECT adapter_instance_id, MAX(completed_at) AS last_at
   FROM sync_runs WHERE status = 'succeeded' GROUP BY adapter_instance_id`
);

/** 某个适配器（可能是多个实例）最近一次成功同步的时间。 */
function lastSuccessfulRun(adapter) {
  let newest = null;
  for (const row of lastSuccess) {
    if (!row.adapter_instance_id.startsWith(`${adapter}@`)) continue;
    if (newest === null || row.last_at > newest) newest = row.last_at;
  }
  return newest;
}

for (const probe of SOURCE_PROBES) {
  // activityAt 是「数据源最后一次真的产生了计费调用」的时间。默认退化为
  // 目录内最新文件的 mtime，但那只能证明文件被动过（会话元数据、归档、
  // 压缩都会改 mtime），不能证明发生了模型调用。
  const activityAt = probe.latestActivity ? probe.latestActivity() : newestMtime(probe.roots, 2_000);

  if (activityAt === null) {
    // 目录不存在或从未写入：可能是这台机器没装这个 CLI，也可能是它真的没落盘。
    const activity = sourceActivity.get(probe.source);
    const staleDays = activity?.last_at ? daysSince(activity.last_at) : null;
    if (staleDays !== null && staleDays >= 3) {
      add(
        "WARN",
        "source_silent",
        `${probe.source} 已 ${staleDays.toFixed(1)} 天没有新事件，且 ${probe.roots.join(" / ")} 下也没有任何文件`,
        "数据源完全没有产出。若该 CLI 近期被调用过，检查启动参数里是否带了 --ephemeral / --no-session-persistence 之类的「不落盘」开关。"
      );
    }
    continue;
  }

  if (activityAt >= Date.now() - 86_400_000) {
    const activity = sourceActivity.get(probe.source);
    const lastAt = activity?.last_at ?? null;
    const lastAdapterAt = lastSuccessfulRun(probe.adapter);
    if ((activity?.recent ?? 0) === 0) {
      add(
        "WARN",
        "source_stall",
        `${probe.source} 的数据源 24h 内有活动，但库里 24h 没有新事件`,
        `最近事件 ${lastAt ?? "（无）"}；最近一次成功的 sync ${lastAdapterAt ?? "（无记录）"}。先确认这 24h 是否真的发起了模型调用；确认有调用而库里没有，就是解析或游标卡住。`
      );
    }
  }
}

// 6. 跨来源重复。时间戳不能要求完全相同：transcript 与 CLI 日志各自取时间，
// 同一次请求会差几毫秒到几十毫秒，所以按 token 数完全相同 + 时间窗口判定。
const duplicates = scalar(
  `SELECT COUNT(*) FROM (
     SELECT session_id, message_id
     FROM usage_events
     WHERE occurred_at >= ?
     GROUP BY session_id, message_id, usage_measurement,
              raw_input_tokens, displayed_input_tokens, output_tokens,
              cache_read_input_tokens, cache_creation_input_tokens
     HAVING COUNT(*) > 1
        AND (julianday(MAX(occurred_at)) - julianday(MIN(occurred_at))) * 86400000.0 <= 2000
   )`,
  ISO_CUTOFF
);
if (duplicates > 0) {
  add(
    "WARN",
    "cross_source_duplicate",
    `${duplicates} 组用量被记录了不止一次`,
    "同一次请求被 transcript 和 CLI 日志各记一次（时间戳差几毫秒）。检查两个 adapter 是否互查对方的 messageId 账本；存量用 purge-usage-duplicates.mjs 清理。"
  );
}

// 7. credit 缺口。只有日志里真的带积分的来源才检查：transcript 来源
// （workbuddy-usage）本身没有积分字段，恒为 NULL 是正常的，不能当异常报。
//
// 按「会话」判而不是按「行」判。CodeBuddy CLI 用 headless 模式派发的调用
// （`--no-session-persistence`，any-subagent 那类）每次都是新 conversation，
// 一个会话只有一行，日志里往往既没有 provider 缓存行也没有计费行 —— 那是
// 数据源限制，不是配对 bug。按行算会把这类调用全算成缺口（实测占 63.8%，
// 而多轮会话内部只有 0.2%），WARN 常亮之后就等于没有 WARN。
// 真正能反映配对是否正常的是多轮会话：一次交互里多轮请求共用同一套
// qua.end / Credit received 行，配错就会成片丢积分。
const creditBySession = rows(
  `WITH per_session AS (
     SELECT session_id,
            COUNT(*) AS calls,
            SUM(CASE WHEN credit IS NULL THEN 1 ELSE 0 END) AS missing
       FROM usage_events
      WHERE occurred_at >= ? AND usage_source = 'codebuddy-log'
      GROUP BY session_id
   )
   SELECT CASE WHEN calls >= 2 THEN 'multi' ELSE 'headless' END AS kind,
          COUNT(*) AS sessions,
          SUM(calls) AS total,
          SUM(missing) AS missing
     FROM per_session
    GROUP BY kind`,
  ISO_CUTOFF
);
const multiSession = creditBySession.find((row) => row.kind === "multi");
const headlessSession = creditBySession.find((row) => row.kind === "headless");
if (multiSession !== undefined && multiSession.missing > 0) {
  const ratio = multiSession.missing / multiSession.total;
  // 多轮会话实测缺失率 0.2%（987 行缺 2 行），正常值极低，阈值收到 10%
  // 才能在配对逻辑真坏了的时候早期发现。
  if (ratio >= 0.1) {
    add(
      "WARN",
      "credit_gap",
      `codebuddy-log 多轮会话近 ${days} 天有 ${multiSession.missing}/${multiSession.total} 次请求没有积分（${Math.round(ratio * 100)}%）`,
      "多轮会话内部的积分行与请求行没配对。检查 CREDIT_SOURCE 白名单是否还匹配日志里的 source 值，以及 credit 行是否被写到另一个日志文件里。"
    );
  }
}
// headless 一次性调用的缺口单独观察：不算异常，但要让数字露出来 ——
// 这部分 token 在总量里，却没有对应的计费记录，读成本面板时要心里有数。
if (headlessSession !== undefined && headlessSession.missing > 0) {
  const headlessRatio = headlessSession.missing / headlessSession.total;
  observe(
    "headless 单次调用",
    `${headlessSession.sessions} 个单行会话里 ${headlessSession.missing} 次没有积分（${Math.round(headlessRatio * 100)}%）；` +
      "每次调用一个新 conversation，日志本身不写计费行，已从 credit_gap 判定中排除，其 token 仍计入总量"
  );
}

// 8. 同步运行健康度
const runHealth = rows(
  `SELECT status, COUNT(*) AS total FROM (
     SELECT status FROM sync_runs ORDER BY rowid DESC LIMIT 200
   ) GROUP BY status`
);
const failedRuns = runHealth
  .filter((row) => row.status !== "succeeded")
  .reduce((sum, row) => sum + row.total, 0);
const totalRuns = runHealth.reduce((sum, row) => sum + row.total, 0);
if (totalRuns > 0 && failedRuns / totalRuns > 0.3) {
  add(
    "WARN",
    "sync_run_health",
    `最近 ${totalRuns} 次同步里有 ${failedRuns} 次没有成功`,
    "个别 aborted 是正常的并发抢占；占比过高说明适配器在持续失败。可用 sync_runs.error_summary 定位。"
  );
}

const unbilledModels = scalar(
  `SELECT COUNT(*) FROM usage_events WHERE occurred_at >= ? AND (model_id IS NULL OR model_id = '')`,
  ISO_CUTOFF
);
if (unbilledModels > 0) {
  add(
    "WARN",
    "model_missing",
    `${unbilledModels} 行没有 model_id`,
    "这些请求无法定价，面板里会落到「未知模型」。检查解析是否读到了模型字段。"
  );
}

// 9. 事件日志 vs 投影表：已经写进日志的用量，必须能在 usage_events 里找到。
// 采集链路「看着健康」（有新的 sync、有新事件）但历史整段没回放时，前八项
// 检查全部通过，只有按来源比对行数才能发现。只扫活动段 events.jsonl：归档段
// 可能在重建时被有意清理过，拿它比会误报。
const logCoverage = auditLogUsageCoverage();
if (logCoverage !== null) {
  for (const entry of logCoverage.sort((a, b) => b.missing - a.missing)) {
    // 日志追加与投影之间本来就有延迟，尾部少量事件未投影是正常的。
    const tolerance = Math.max(100, Math.round(entry.total * 0.02));
    if (entry.missing <= tolerance) continue;
    add(
      "WARN",
      "event_log_gap",
      `${entry.vendor} 日志里有 ${entry.missing} 条用量在库里找不到对应行（日志共 ${entry.total} 条）`,
      "日志在、库不在：重建库或游标越过文件末尾时，历史事件没有被回放。比对 ingestion_state.offset 与日志大小、normalized_events 行数，必要时回放历史事件。"
    );
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const worst = findings.reduce(
  (level, item) => (item.level === "FAIL" ? "FAIL" : level === "FAIL" ? "FAIL" : item.level === "WARN" ? "WARN" : level),
  "PASS"
);

if (asJson) {
  console.log(JSON.stringify({ dbPath, days, verdict: worst, findings, observations }, null, 2));
} else {
  console.log(`用量库：${dbPath}`);
  console.log(`回看窗口：${days} 天\n`);

  console.log("来源活动：");
  for (const [source, activity] of [...sourceActivity.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${source.padEnd(24)} 共 ${String(activity.total).padStart(6)} 次 · ` +
        `24h ${String(activity.recent).padStart(5)} 次 · 最近 ${activity.last_at}`
    );
  }
  console.log("");

  if (findings.length === 0) {
    console.log("PASS —— 没有发现异常。");
  } else {
    for (const item of findings) {
      console.log(`[${item.level}] ${item.check}`);
      console.log(`  ${item.summary}`);
      console.log(`  → ${item.detail}\n`);
    }
    console.log(`结论：${worst}`);
  }

  if (observations.length > 0) {
    console.log("");
    console.log("观察（不计入结论）：");
    for (const item of observations) console.log(`  ${item.label}：${item.text}`);
  }
}

db.close();

if (worst === "FAIL") process.exit(2);
if (worst === "WARN" && strict) process.exit(1);
process.exit(0);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 返回目录树里最新的文件 mtime（毫秒），没有任何文件时返回 null。 */
function newestMtime(roots, budget) {
  let newest = null;
  let visited = 0;

  const walk = (dir, depth) => {
    if (depth < 0 || visited >= budget) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= budget) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth - 1);
      } else if (entry.isFile()) {
        try {
          const mtime = statSync(fullPath).mtimeMs;
          if (newest === null || mtime > newest) newest = mtime;
        } catch {
          // 文件正在被写时可能 stat 失败，忽略。
        }
      }
    }
  };

  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, 2);
  }
  return newest;
}

function daysSince(isoTimestamp) {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) return null;
  return (Date.now() - parsed) / 86_400_000;
}

/**
 * 比对活动事件日志与 usage_events：日志里写过的每一次用量，库里必须有对应行。
 *
 * 不能只比 event_id。purge-legacy-duplicates 会删掉与 legacy 副本重复的 v2
 * 事件，留下时间戳与 message_id 相同、id 不同的那一条；按 id 比会把这批
 * 「按设计去重」的行误报成缺口。所以同一次请求按 message_id + occurred_at
 * 认定，只有没有 message_id 的行才退回比 event_id。
 *
 * 分块同步读取：日志已经是几百 MB 的量级，一次性读进内存会把体检脚本自己
 * 变成负担，而这里只需要几个 ASCII 字段。
 */
function auditLogUsageCoverage() {
  if (dataRoot === null) return null;
  const logPath = join(dataRoot, "data", "events", "events.jsonl");
  if (!existsSync(logPath)) return null;

  const needle = '"type":"token.usage.recorded"';
  const perVendor = new Map();
  let fd;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return null;
  }

  const buffer = Buffer.allocUnsafe(1 << 20);
  let rest = "";
  const collect = (line) => {
    if (!line.includes(needle)) return;
    const vendor = /"source_vendor":"([^"]+)"/u.exec(line)?.[1];
    if (!vendor) return;
    let entry = perVendor.get(vendor);
    if (entry === undefined) {
      entry = { total: 0, byRequest: new Set(), byEventId: new Set() };
      perVendor.set(vendor, entry);
    }
    entry.total += 1;
    const messageId = /"message_id":"([^"]+)"/u.exec(line)?.[1];
    const timestamp = /"timestamp":"([^"]+)"/u.exec(line)?.[1];
    if (messageId && timestamp) {
      entry.byRequest.add(`${messageId}|${timestamp}`);
    } else {
      const eventId = /"event_id":"([^"]+)"/u.exec(line)?.[1];
      if (eventId) entry.byEventId.add(eventId);
    }
  };

  try {
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      const lines = (rest + buffer.toString("utf8", 0, read)).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) collect(line);
    }
    if (rest.length > 0) collect(rest);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  const coverage = [];
  for (const [vendor, entry] of perVendor) {
    const knownRequests = new Set(
      rows(
        "SELECT message_id, occurred_at FROM usage_events WHERE source_vendor = ? AND message_id IS NOT NULL",
        vendor
      ).map((row) => `${row.message_id}|${row.occurred_at}`)
    );
    const knownNullIds = new Set(
      rows("SELECT event_id FROM usage_events WHERE source_vendor = ? AND message_id IS NULL", vendor).map(
        (row) => row.event_id
      )
    );
    let missing = 0;
    for (const key of entry.byRequest) {
      if (!knownRequests.has(key)) missing += 1;
    }
    for (const eventId of entry.byEventId) {
      if (!knownNullIds.has(eventId)) missing += 1;
    }
    coverage.push({ vendor, total: entry.total, missing });
  }

  return coverage;
}
