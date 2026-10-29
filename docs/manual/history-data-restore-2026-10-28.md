# Agent Metrics 历史数据恢复 Spec

日期：2026-10-28
状态：已执行（2026-10-28 17:40）。本文件保留为执行记录与验收依据，第 9 节是实际结果。

## 1. 目标

将 2026-10-22 备份中的历史业务数据去重合并到当前数据库，恢复 3–9 月及备份内的 10 月数据，同时保留当前库中 10 月 23–28 日的新数据。

不得直接用旧备份替换当前数据库。

## 2. 已确认现状

当前库的 `usage_events` 曾大量缺失历史记录。10 月 22 日备份仍保留完整历史，因此采用“当前库优先、旧备份补缺”的合并方式。

ZCode 两次执行均超时，只有心跳，没有完成正式合并。当前数据库 `PRAGMA integrity_check` 为 `ok`。

来源备份里的 3–6 月同时存在 `legacy:` 与 `v2:` 两份**完全等价**的记录（同 session、同 message、
同时间、同 token），属于 2026-07-20 `000-adopt-legacy-baseline` 回填与 v2 管道重复解析留下的双计。
因此「来源库行数」不等于「合并后应有记录数」，必须按 `session_id + message_id + occurred_at`
去重后再合并，合并完成后再用 `purge-legacy-duplicates.mjs` 清掉克隆副本。下表已按去重口径修正：

| 月份 | 来源库行数 | 其中克隆对 | 合并后唯一记录 |
|---|---:|---:|---:|
| 2026-03 | 82 | 39 | 43 |
| 2026-04 | 864 | 416 | 448 |
| 2026-05 | 19,141 | 9,841 | 9,300 |
| 2026-06 | 18,347 | 5,127 | 13,220 |
| 2026-07 | 26,982 | 0 | 26,982 |
| 2026-08 | 38,769 | 0 | 38,803 |
| 2026-09 | 53,713 | 0 | 53,805 |
| 2026-10 | 34,715 | 0 | 46,936 |

8、9 月高于来源库，是当前库本来就有的、备份之后才落库的记录；10 月同理合并进当前库的新数据。
3–6 月的「克隆对」逐条核对过 token 完全相等，删掉任何一侧都不改变总量。

当前库 `occurred_at >= 2026-10-23T00:00:00.000Z` 在合并时有 12,182 条；合并前后该数量必须不变。

## 3. 文件位置

当前库：

```text
C:\Users\qinyang.li\AppData\Roaming\Agent Metrics\agent-metrics-data\data\sqlite\metrics.sqlite
```

只读恢复来源：

```text
D:\backups\agent-metrics\metrics-before-legacy-purge-2026-10-22T12-10-52-287Z.sqlite
```

已生成的当前状态安全备份：

```text
D:\backups\agent-metrics\metrics-before-zcode-restore-2026-10-28T08-38-03-298Z.sqlite
```

如果当前库在安全备份生成后又发生业务写入，手动执行前必须再创建一份新备份。

## 4. 执行前置条件

1. 关闭 Agent Metrics 正式版、开发版及其 Core/CLI 运行时，确保没有进程写当前库。
2. 不启动应用执行同步，避免合并期间产生并发写入。
3. 使用 better-sqlite3 的 `db.backup()` 备份当前库，不只复制主文件而忽略 WAL。
4. 使用项目 Node 22，避免 Node 24 与 better-sqlite3 原生模块 ABI 不匹配：

```text
D:\projects\dev\agent-metrics\.runtime\node-v22.22.3-win-x64\node.exe
```

加载方式：

```js
const { createRequire } = require("node:module");
const requireFromCore = createRequire("D:/projects/dev/agent-metrics/apps/core/package.json");
const Database = requireFromCore("better-sqlite3");
```

## 5. 合并规则

1. 以来源库只读 `ATTACH` 到当前库。
2. 所有业务插入放在一个事务中。
3. 当前库只允许 `INSERT OR IGNORE`；禁止 `DELETE`、`UPDATE`、`DROP`、`ALTER`。
4. 当前行优先，不用旧行覆盖或更新当前行。
5. 每张表显式使用当前表与来源表的共有列，不得 `SELECT *` 插入。当前库已到 `009-add-usage-credit`，来源库可能缺少新列。
6. 表或列不存在时记录并跳过，不为旧表强行修改结构。
7. 不合并迁移和运行状态，当前状态保持不动。

业务表按以下顺序处理：

```text
source_instances
adapter_instances
normalized_events
event_observations
event_diagnostics
domain_sessions
tool_calls
tool_call_aliases
usage_events
pending_usage_migrations
sessions
tool_events
prompt_events
assistant_responses
token_usage_events
code_edits
session_contexts
```

明确排除：

```text
schema_migrations
ingestion_state
projection_watermarks
sync_runs
```

共有列插入形式：

```sql
INSERT OR IGNORE INTO main.<table> (<current_and_source_common_columns>)
SELECT <current_and_source_common_columns> FROM source.<table>;
```

列名应通过 `PRAGMA table_info` 动态求交集并显式生成，不能使用未经验证的表名输入。

## 6. 失败处理

- 任一步骤失败：回滚整个事务并停止，不采用删除、替换或分段覆盖方案。
- 恢复前备份必须保留。
- 如果提交后的验收失败，保持应用关闭，保留失败现场供诊断，使用最近的安全备份进行离线恢复。
- 不删除失败库、来源备份或安全备份。

## 7. 验收要求

### 7.1 完整性

```sql
PRAGMA integrity_check;
```

必须返回 `ok`。

### 7.2 各月用量

```sql
SELECT substr(occurred_at, 1, 7) AS month, COUNT(*) AS count
FROM usage_events
GROUP BY month
ORDER BY month;
```

按本 spec 快照，结果应达到第 2 节「合并后唯一记录」（已按克隆去重口径修正）。如果执行前当前库有新增，
结果只能增加，不能减少。

### 7.3 当前新数据未丢失

```sql
SELECT COUNT(*) AS count
FROM usage_events
WHERE occurred_at >= '2026-10-23T00:00:00.000Z';
```

本快照必须仍为 `12,182`。同时检查合并前记录的各业务表行数，合并后均不得减少。

### 7.4 运行状态未合并

确认 `schema_migrations`、`ingestion_state`、`projection_watermarks`、`sync_runs` 未因来源备份发生回退或替换。

### 7.5 输出记录

保留以下执行结果，便于主 Agent 复核：

- 执行前新生成的备份路径（如有）
- 每张表实际插入行数
- 跳过表/列及原因
- 合并前后各月 `usage_events` 数量
- `PRAGMA integrity_check` 结果

## 8. 执行记录（2026-10-28）

### 8.1 实际步骤

1. `metrics-before-history-merge-2026-10-28T09-02-27-723Z.sqlite` 由 `db.backup()` 生成，作为合并前现场。
2. 按第 5 节规则单事务 `INSERT OR IGNORE` 合并 17 张业务表，`usage_events` 插入 192,500 行，
   `normalized_events` 889,931 行，其余表见执行输出。跳过项：`usage_events` 的来源表缺
   `service_tier` / `credit` 两列，按共有列插入，这两列为默认值。
3. 合并后 `usage_events` 一度到 204,960 行，多出来的是 3–6 月的克隆副本；
   跑 `scripts/purge-legacy-duplicates.mjs --apply` 清掉 13,954 行，落到 189,537 行。
4. 事件日志回放：`ingestion_state.offset` 当时指向文件末尾，10-22T12:10:52 之后的日志从未投影过。
   把这段（10-22T12:10:52 – 10-23T02:00）缺失的事件行追加到 `events.jsonl` 末尾，再让投影消费到文件末尾，
   `normalized_events` 从 41,554 涨到 919,611，`usage_events` 补上 Codex/WorkBuddy/Kimi 的真实缺口。
   **没有**把 `offset` 归零重放全量 —— 那会把刚清掉的重复行一起放回库。

### 8.2 验收结果

| 项目 | 结果 |
|---|---|
| `PRAGMA integrity_check` | `ok` |
| 各月 `usage_events` | 与第 2 节修正后的唯一记录数一致（10 月为合并后继续增长的值） |
| `occurred_at >= 2026-10-23` | 合并时 12,182 条不变；此后正常增长到 13,231 条 |
| 运行状态 | `schema_migrations`=9、`ingestion_state`、`projection_watermarks`、`sync_runs` 未被来源库覆盖 |
| 同 session+message+时间 重复 | 1 组（历史遗留），其余 0 |
| 日志 vs 库（业务键） | 除 3,775 条按设计去重的克隆、1 条边界行（已单独补回）外全覆盖 |
| `audit:usage --days 7` | 无 `event_log_gap`；仅剩既有的 codebuddy `credit_gap` WARN |

### 8.3 遗留与后续

- 缺模型的历史行：全表 2,500 行（不止 3–6 月，3–10 月都有），已用 `scripts/backfill-usage-model.mjs`
  回补 1,073 行（从 rollout 的 `turn_context` 按时间精确对应）。剩 1,427 行落在 04-14 / 06-16 /
  07-30 / 08-24 / 09-14 五个批次、共 23 个会话，rollout 已被 Codex 回收到 `archived_sessions` 之外，
  `logs_2.sqlite`、`state_5.sqlite`、`thread_history_1.sqlite` 里也无痕迹，**不可恢复**；
  同日同源的模型分布过于分散（07-30 四种、09-14 三种），不做推断，留在「未知模型」。
  脚本回补前已备份：`D:\backups\agent-metrics\metrics-before-model-backfill-2026-10-28T17-39-10.sqlite`。
- 本次回放暴露的机制缺陷已固化为 `docs/manual/usage-source-playbook.md` 的 R9（条件式丢弃）、
  R10（只认一条用量路径）、R11（重建后按业务键比对日志与库），以及 `scripts/audit-usage.mjs`
  新增的 `event_log_gap` 检查项 —— 下次重建库若再漏回放，体检会直接报出来。

