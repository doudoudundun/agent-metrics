# 用量来源接入与防复发手册

这份文档只解决一件事：**数据源静默失效**。它不报错，只让面板上的数字悄悄变少、变小或变大，
而人往往要过几天才觉得「好像不对」。下面每一条规则都对应一次真实事故，接入新来源或改解析逻辑前请逐条对照。

体检入口：

```bash
corepack pnpm audit:usage          # 人读报告，有 FAIL 返回 2
corepack pnpm audit:usage:strict   # WARN 也返回非 0，适合放进定时任务
node scripts/audit-usage.mjs --days 14 --json
```

## 一、三条不变量

`usage_events` 里每一行都必须能通过这三条检查，否则面板一定不对：

1. **输入语义要声明**。`gross` 表示 `raw_input_tokens` 是本次请求的完整 prompt 大小；
   `delta` 表示它只是本次新增的部分。语义写在 `packages/event-schema/src/usage.ts` 的
   `USAGE_SOURCE_SEMANTICS` 里，adapter 不许自己另算一套。
2. **`gross` 行的缓存不能超过输入**：`cache_read + cache_creation ≤ raw_input`。
   面板展示的输入是 `raw - cache_read`，由 `displayedInputTokens()` 统一计算，adapter 和投影都不许自己减。
3. **缓存量只出现一次**：`total = displayed_input + output + cache_read + cache_creation`。
   把 `cache_read` 再算进 input 就是双计（面板输入虚高的典型原因）。

`delta` 来源不受第 2 条约束：它的 `input` 是增量，`cache_read` 是独立的缓存命中量，
`cache_read > input` 完全正常（dsh / kimicode / cursor 常出现比例几十倍的情况，不是脏数据）。

## 二、规则（按踩坑时间排序）

### R1 不要让 CLI 关掉落盘

`--ephemeral`（Codex）、`--no-session-persistence`（Claude Code / CodeBuddy）会让一次调用
**一个字节都不留**，adapter 再完美也采不到。2026-10 的 42 次 Codex 调用就是这样永久丢失的
（连 tracing 都没写），事后无法回补。

- 调用方在 `any-subagent` 仓库，`src/managed-backend.ts` / `src/codex.ts` 里有断言测试防止回归。
- 新接入一个 CLI 时，先跑 10 次调用，确认对应目录真的出现了 session 文件，再接解析。

### R2 缓存字段以真实记录为准，不要凭印象

CodeBuddy 的缓存读数在 `agent.model_call.completed` 事件行里的 `cached_read_tokens`，
不在 `token`/`usage` 记录里，也不叫 `prompt_cache_hit_tokens`。第一版按后者的名字去找，
结论是「日志里没有缓存信息」，于是全量记 0，面板输入虚高 10 倍。

判断字段是否存在，必须 `grep` 真实日志，不许靠字段名推测，也不许因为一次搜索没命中就下结论。

### R3 后置字段要能重发，不要一次性配对

积分（`credit`）、缓存拆分、cache_creation 这类字段，往往在请求记录之后几行才落盘，
甚至跨两个同步批次。做法是：

- 事件先照常写入（缺的字段留空）；
- 账本额外记 `<key>:credit`、`<key>:cache` 这类「明细已见过」的键；
- 下一轮再看到同一请求且明细键缺失时**重发同一条事件**；
- 投影层用 `reconcileUsageCredit` / `reconcileUsageCache` 按 `event_id` 打补丁。

反例：只在 `qua.end` 之后找 credit，且把 `source=response_done` 也当成候选，结果 100% 配不上。

### R4 活跃日志必须增量读，不能等文件静默

「等文件 30 秒不再变化再读」在 22 MB 且持续写入的日志上永不成立。正确做法：
按 offset 增量读，并在每次读取时回读尾部一个固定窗口（`OVERLAP_BYTES`）覆盖跨批次的配对。

### R5 模型等属性优先取自数据源自身

Codex 的模型名原先从 `~/.codex/logs_2.sqlite` 的 `conversation.id=... model=...` 推断。
但这个 tracing 库并不是每次调用都写，于是 19 行用量没有 `model_id`，无法定价、落在「未知模型」。
现在优先读 rollout 文件里的 `turn_context.payload.model`，旁路日志只作兜底。
凡是「主数据源里有、却去别的文件里推断」的字段，都要按这个顺序改过来。

历史存量用 `scripts/backfill-usage-model.mjs` 回补：按用量行时间取该会话最近一条
`turn_context` 的模型，同时更新 `normalized_events` 的 payload 与语义指纹（否则重放时会被判冲突）。
两个坑必须一起修，否则脚本看起来「跑完了但一行都没补」：

- Codex 把较早的 rollout 压成 `rollout-*.jsonl.zst`，只匹配 `.jsonl` 会让整批老会话报「找不到 rollout 文件」。
  Node 22 自带 `zlib.zstdDecompressSync`，不用装 zstd 命令行。
- 已归档会话被移到与 `sessions` 同级的 `archived_sessions/`，只扫 `~/.codex/sessions` 同样找不到。

2026-10-28 实测：全表 2,500 行缺模型，加上这两处后 1,073 行精确回补成功。
剩下 1,427 行（04-14 / 06-16 / 07-30 / 08-24 / 09-14 五个批次共 23 个会话）的 rollout
已被 Codex 回收，`logs_2.sqlite`、`state_5.sqlite`、`thread_history_1.sqlite` 里都没有这些会话的痕迹 ——
这一批**不可恢复**。同日同源推断不可用：07-30 同日存在 4 个不同模型、09-14 有 3 个，
强行套用会把成本算到错的模型上，宁可留空让面板显示「未知模型」。

### R6 改动后立刻体检

不要等用户发现面板不对。改完 adapter：

```bash
corepack pnpm audit:usage
```

`cache_gap` / `source_stall` / `model_missing` 任何一条变红，先修再交付。

### R7 桌面版加载的是打包产物，不是仓库源码

`apps/desktop/release/win-unpacked/resources/runtime/` 里是打包时拷贝的 `core` / `cli` / `dashboard`，
用户实际运行的桌面应用只认这一份。改了 adapter 而不重新打包，表现为「源码和测试都对，面板就是没数据」，
而且**没有任何报错**：旧的 core 里根本没有注册这个 adapter，`sync_runs` 里连它的记录都不会出现。

交付顺序固定为：`corepack pnpm -r build` → 关闭桌面应用 → `corepack pnpm --filter @agent-metrics/desktop package:win:dir` → 重新启动。

判断桌面包是否包含某个 adapter：

```bash
grep -c "codebuddy-cli-log" apps/desktop/release/win-unpacked/resources/runtime/core/dist/app.js
```

结果为 0 就是没打进去。

### R8 `usageScope` 不止 `turn` 一种

Kimi Code 的 wire 把一次**上下文压缩**（`full_compaction.begin` → `llm.request` → `usage.record` → `context.apply_compaction`）
的整体用量写成 `usageScope: "session"`，模型是压缩时配置的那个，常常不是当前 turn 的模型。
第一版解析器只收 `"turn"`，把 165 次压缩请求整批丢掉，其中 7 次是 Xiaomi MiMo 调用 ——
面板上这些行根本不出现，而 turn 一栏完全正常，属于最难发现的那种静默缺失。

- 压缩行是一笔真实、可计费的请求，必须计入；`usageScope` 只认 `turn` / `session`，其它值丢弃。
- 压缩行没有自己的 messageId，不许借用上一个 turn 的 `messageId`／`pendingStepTiming`，否则会把 token 和 TTFT 记到上一轮头上。
- 已经越过游标的丢失记录只能靠重放回补：拿解析器逐个 wire 重跑，把补出来的事件直接追加到 `events.jsonl`（投影按 `event_id` 幂等）。

### R9 不要用「字段全非空」当产出条件

Cursor 的 `bubbleId` 生成记录里，`inputTokens` / `outputTokens` 是每次都有，四个缓存计数却经常缺。
第一版写成「输入、输出、缓存读、缓存写**四个都非 null** 才产出 usage」，于是一条有真实 token 的记录
可能整条消失 —— 面板上不报错、不告警，只是少一次调用。缓存计数缺失应当补 0，而不是否决整条记录。

- 判据只压在最关键的字段上（输入 + 输出），其余可选字段缺失补 0。
- 同一毛病在 OpenCode 侧也有镜像写法：`tokenPayload !== null && usagePart === null`，两条路径互斥取其一，
  改其中一条前先确认另一条能覆盖同一批记录。

### R10 一个源有多条用量路径时，不能只认一条

Codex 的 rollout 同时写 `event_msg/token_count`（含累计快照）和逐响应的 `token_usage_record`。
解析器只读前者：`token_count` 一旦缺（老版本、被裁剪的 rollout、将来改格式），整个文件就是 0 用量。
现在 `token_usage_record` 被缓冲为兜底，只在整份文件没有任何 `token_count` 用量时才启用，
两条路径不会双计。同一处还顺手修了模型来源：模型取 `turn_context.model`，
而不是旁路 tracing 日志（`conversation.id=… model=…`）—— 那份日志并非每次调用都写，会留下 NULL 模型。

- 兜底路径必须能判断「主路径已经产出过」，否则就是双计。
- 模型等属性优先取自数据源自身的事件流，不依赖旁路日志（同 R5）。

### R10b 跨 adapter 的 messageId 账本要双向互查

WorkBuddy 有两条读取路径：transcript（`workbuddy-usage`）和 CLI 请求日志（`codebuddy-log`）。
CLI 日志 `settleMs = 0`，请求行一落盘就被读，通常**早于**同一条请求的 transcript 行；
transcript adapter 早先只查自己的账本，于是后写的一方把同一次请求又记了一行——2026-10-28
一天就是 300 对（28.5M token，占当日 2.6%）。

- 两个 adapter 必须互查对方的 `:usage:<messageId>` 账本，谁后写谁跳过。
- 库里去重不能按 `occurred_at` 完全相同匹配：两条路径的时间戳差 4~44ms，
  要按 token 数 + 时间窗口（默认 2s）判定。

### R11 重建库之后，按业务键比对日志与库

10-23 重建库时 `ingestion_state.offset` 指向了文件末尾，重建前的日志没有被回放：
Claude Code 与 MiMo 整源不在面板上，ZCode 只剩 79 条，Codex/WorkBuddy/Kimi 缺三分之二历史，
共 28,594 条。当时 `audit:usage` 全绿 —— 它只查「最近还在不在动」，不查「历史在不在」。

- 比对键是 `message_id + occurred_at`，不是 `event_id`：`purge-legacy-duplicates` 会删掉与 legacy 副本
  重复的 v2 行，留下时间戳相同、id 不同的一条，按 id 比会把「按设计去重」误报成缺口。
- 已有 `event_log_gap` 检查项固化了这条比对（`scripts/audit-usage.mjs`）。
- 回补方式：把日志里缺的事件行追加到 `events.jsonl` 末尾，再让投影消费到文件末尾即可；
  直接改 `ingestion_state.offset` 会把被有意清掉的重复行一起重放回来。

### R12 覆盖率告警要按业务单元聚合，不能按行数算

`credit_gap` 一直亮着 64%，一度以为是积分配对逻辑坏了。真实情况相反：把窗口内
`codebuddy-log` 的用量按 `session_id` 聚合再算——

| 会话形态 | 会话数 | 行数 | 无积分行 | 缺失率 |
|---|---|---|---|---|
| 多轮会话（≥2 次调用） | 20 | 987 | 2 | **0.2%** |
| 单行会话（headless 一次性调用） | 1,748 | 1,748 | 1,743 | 99.7% |

配对逻辑是好的。缺口全部来自 CodeBuddy CLI 的 headless 派发：`--no-session-persistence`
让每次调用都是新 `conversation_id`，一个会话只有一行，日志里本来就不写计费行
（`any-subagent` 那类调用，`avg_output` 只有 4 token，输入 18.5k 是系统提示）。

- **按行算覆盖率，分母里混进了结构上不可能有值的调用**，比值失去意义；WARN 常亮之后
  等于没有 WARN，真回归了也看不出来。
- 现在的判定：多轮会话内部缺失率 ≥ 10% 才 WARN（实测 0.2%，余量足够，同时比原来
  的 40% 灵敏得多）。单行会话的缺口改为「观察项」，不参与结论，但数字照样打印。
- 代价要说清楚：这部分 headless 调用的 token 计入了总量，却没有对应积分。
  近期窗口里它占 `codebuddy-log` token 的约 24%，读成本面板时要扣掉这块。

同一套路适用于其他「按比例判异常」的检查：先问一句**分母里有没有结构上不该有值的行**。

## 三、接入新来源的检查清单

- [ ] 在 `packages/event-schema/src/sources.ts` 注册 `usage_source` 与 vendor/adapter 映射
- [ ] 在 `USAGE_SOURCE_SEMANTICS` 声明 `inputTokenSemantics` / `usageMeasurement`
- [ ] 解析器对「字段缺失」和「字段为 0」区别对待：缺失留 `null`，不要补 0
- [ ] 事件 `event_id` / `message_id` 稳定可重放；后置字段用带后缀的账本键允许重发
- [ ] 与已有来源共享 messageId 去重（transcript 与 CLI 日志会记录同一次请求）
- [ ] 在 `packages/test-utils/src/source-isolation.ts` 增加隔离用环境变量（如果读真实目录）
- [ ] 在 `scripts/audit-usage.mjs` 的 `SOURCE_PROBES` 增加探针，指向**真正被解析的子目录**
- [ ] 用真实日志跑一次，核对「日志里的请求数」与「入库行数」基本一致
- [ ] 跑 `audit:usage`，`model_missing`、`cache_gap`、`cross_source_duplicate` 为 0

## 四、故障速查

| 症状 | 先查 |
| --- | --- |
| 某 CLI 完全没有数据 | 目录是否产生文件（R1）；`sync_runs` 是否有该 adapter 的成功记录 |
| 输入 token 突然变大 10 倍 | 缓存字段没读到（R2）；`cache_gap` 检查项 |
| 输入 token 比实际小 | 把缓存算进了输入（不变量 3）；`semantics_mismatch` |
| 面板出现「未知模型」 | `model_missing`；model 是否只从旁路日志推断（R5） |
| 同一次请求算两次 | `cross_source_duplicate`；两个来源的 messageId 去重账本（**必须双向互查**：谁后写谁跳过，只做单向仍会双计）；时间戳差几毫秒，判定按 token 数 + 2s 窗口，清理用 `purge-usage-duplicates.mjs` |
| 积分长期为 0 | `credit_gap`；后置字段是否允许重发（R3）；**先按会话聚合再判断**，headless 单次调用本来就没有计费行（R12） |
| 某模型完全不出现，别的模型正常 | 该请求是否换了 scope／类型（R8，压缩请求记在 `session` 下） |
| 某来源偶发整条缺失，且不报错 | 解析器是否要求多字段全非空（R9）；是否还有第二条用量路径没读（R10） |
| 某来源整段历史空白，近期却正常 | 按业务键比对日志与库（R11）；`event_log_gap` 检查项 |

## 五、位置备忘

- 真实数据根：`%APPDATA%\Agent Metrics\agent-metrics-data`（macOS/Linux 见 `apps/core/src/server-runtime.ts`）。
  仓库内 `data/` 是历史库，不能用来判断现状。
- 用量库：`<数据根>/data/sqlite/metrics.sqlite`
- 事件日志：`<数据根>/data/events/events.jsonl`
- 游标与账本：`<数据根>/data/sources/state/`
- 把游标里某个文件的 `offset` 归零可以强制重扫该文件；重扫靠账本去重，
  带 `:credit` / `:cache` 后缀的明细会重新下发并补齐历史行。改动前先备份该 JSON。
