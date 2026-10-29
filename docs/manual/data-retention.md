# 历史明细保留策略与裁剪机制

热库（`<dataRoot>/data/sqlite/metrics.sqlite`）里最重的东西不是用量数字，而是每一条
事件带的完整 `payload_json`。一次重建之后库会涨到 3~4GB，其中 90% 是历史明细。
本机制把「明细」按时间窗口裁剪掉，只保留能算出所有聚合数字的那部分。

## 三层保留

| 层 | 内容 | 保留窗口 | 尺寸特征 |
| --- | --- | --- | --- |
| 事实层 | `usage_events`（token / 模型 / 供应商 / 会话 / 时间）、`tool_calls`（工具调用计数与耗时，工具面板唯一来源）、`sessions` + `domain_sessions` | 全量 | 小，~180MB |
| 骨架层 | `normalized_events` 里的 `prompt.submitted` / `assistant.responded` / `code.edit.applied` / `session.started` / `session.ended` | 全量 | 中 |
| 明细层 | `normalized_events` 里的 `tool.called` / `tool.succeeded` / `tool.failed` / `token.usage.recorded`；`event_observations` / `event_diagnostics` / `tool_events` / `token_usage_events` / `assistant_responses` / `prompt_events` / `code_edits` | 最近 N 个自然月 | 大，占库 70%+ |

关键取舍：`normalized_events` 里只有四类算「明细」，其余几类**是聚合口径的计数来源**。
总量面板的 prompt 数、响应数、代码编辑统计直接 `SELECT ... FROM normalized_events
WHERE event_type = 'prompt.submitted'`，删了这几类数字会掉到 0。所以脚本用白名单写法
（`DETAIL_EVENT_TYPES`），新增事件类型默认落在「保留」一侧。

裁剪后能看见的变化：

- 总量、趋势、模型分布、供应商分布、会话数与每会话 token —— **完全不变**
- 工具面板 —— 正常，`tool_calls` 属于事实层，不裁剪
- 裁剪点之前的会话点进去 timeline 为空或只剩 prompt/response/edit 骨架
- 代码编辑统计 —— 保留窗口内正常（`code_edits` 是明细，窗口外删掉了）

## 用法

```bash
pnpm retention                     # 默认 --keep-months 4，dry run，只打印计划
pnpm retention -- --before 2026-07-01 --apply          # 归档 + 删除
pnpm retention:apply               # 等价于 --apply --vacuum（要缩文件必须 VACUUM）
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--keep-months <n>` | 保留最近 n 个自然月（含本月）的明细，默认 4。当前 2026-10 → 裁剪点 2026-07-01 |
| `--before <YYYY-MM-DD>` | 直接指定裁剪点，优先于 `--keep-months` |
| `--apply` | 真正归档并删除；不加只做 dry run |
| `--vacuum` | 删除后 `VACUUM` 回收空间。**需要先退出 Agent Metrics**，否则拿不到独占锁 |
| `--no-backup` | 跳过裁剪前全量备份（只在已有近期全量快照时用） |
| `--archive-dir <dir>` | 冷存档目录，默认 `<dataRoot>/data/events/archive/retention` |

产出：

- `<table>-before-<cutoff>.jsonl.zst` —— 每张被裁剪的表一个文件，一行一条原始行（zstd）
- `retention-report-<cutoff>.json` —— 行数、归档大小、裁剪前后体积、裁剪前后的用量指纹
- `retention.log` —— 每次执行追加一行

脚本结束会打印用量指纹对比：只要 `usage_events` 行数 / tokens / 模型数 / 会话数
**没有变少**就算通过。裁剪期间 App 还开着、有新事件写进来时会显示「新写入 +N 行」，
那是正常追加，不是丢失。

## 自动裁剪（Core 内置）

手动脚本没人会记得跑，所以 Core 自己也裁：`apps/core/src/detail-retention.ts` 在
`listen` 之后跑一次，之后按配置间隔复查。它和脚本用**同一套口径**（同样的 8 张表、
同样 4 类 `normalized_events` 明细、同样的 `rowid` keyset 归档），区别只在于：

| | 手动脚本 | Core 内置 |
| --- | --- | --- |
| 备份 | 默认裁剪前全量 `db.backup()` | 不做（启动期不能卡几分钟） |
| VACUUM | `--vacuum` 时做 | 永不做（需要独占，且会把启动拖到分钟级） |
| 归档 | 写 `.jsonl.zst` | 同样写 `.jsonl.zst`，同目录 |
| 触发 | 人执行 | 启动 + 每 ≤6 小时检查一次，按状态文件节流 |
| 失败影响 | 退出码非 0 | 只 `log.warn`，不影响启动与采集 |

配置（环境变量）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_METRICS_DETAIL_RETENTION_ENABLED` | `true` | `0`/`false`/`off` 关闭 |
| `AGENT_METRICS_DETAIL_RETENTION_KEEP_MONTHS` | `4` | 保留最近 n 个自然月（含本月） |
| `AGENT_METRICS_DETAIL_RETENTION_INTERVAL_HOURS` | `24` | 两次裁剪的最小间隔 |

节流靠 `<dataRoot>/maintenance/detail-retention.json` 里的 `lastRunAt`，所以**反复重启
不会重复裁剪**；「无可裁行」也会写一次时间戳，避免每次启动把八张表各扫一遍。

因为不 VACUUM，自动裁剪删掉的行只会变成空闲页，文件大小不降（后续写入会复用这些页，
所以也不会继续涨）。要真正缩文件还是手动跑一次 `pnpm retention:apply` 并退出 App。

> **改口径要两边一起改**：`scripts/retention.mjs` 的 `TARGETS` / `DETAIL_EVENT_TYPES`
> 与 `apps/core/src/detail-retention.ts` 里的同名常量必须逐字对应。只改一边，手动跑和
> 自动跑会删出两个不同的历史。

## 2026-10-28 首次执行记录

裁剪点 `2026-07-01`，归档 474,027 行：

| 表 | 归档删除行数 | 归档文件 |
| --- | --- | --- |
| normalized_events（4 类明细） | 230,101 | 24.6MB |
| tool_events | 199,920 | 6.9MB |
| assistant_responses | 23,254 | 0.7MB |
| token_usage_events | 9,831 | 0.5MB |
| prompt_events | 7,383 | 0.3MB |
| code_edits | 3,538 | 0.2MB |
| event_observations（孤行连带） | 230,101 | — |
| event_diagnostics（孤行连带） | 22,407 | — |

结果：

- 库文件 3,702,489,088 → 2,866,634,752 字节（3.70GB → 2.87GB，**-22.7%**）
- `integrity_check = ok`；`usage_events` 193,610 行、24.39B tokens、月度分布全部原样
- `event_observations` 与 `normalized_events` 行数一致（698,638），无孤行
- `audit:usage --days 7` 之后只剩 codebuddy 的 headless 观察项，结论回到 PASS

## 坑

1. **不能按 `LIMIT/OFFSET` 分页归档**。230k 行按 2000 一批要 115 批，`OFFSET` 每批都
   从头扫，实测 10 分钟只走完 15%。脚本用 `rowid` keyset 分页（`WHERE rowid > ?`），
   同样的量 40 秒走完。
2. **归档目录是 `<dataRoot>/data/events/`，不是 `<dataRoot>/events/`**。后者是 7 月迁移
   遗留的旧目录，写进去等于丢。脚本默认值已对准。
3. **VACUUM 之后主库文件不会立刻变小**。WAL 模式下 VACUUM 的内容先进 WAL，
   要再跑一次 `PRAGMA wal_checkpoint(TRUNCATE)` 才真正落盘截断。`retention:apply`
   在 VACUUM 前做了一次 checkpoint，若 App 还在跑，收尾还要再 checkpoint 一次。
4. **VACUUM 需要独占**。App 开着的时候要么跳过 `--vacuum`（删掉的行先变成空闲页，
   后续写入复用，文件不再长大但也不缩小），要么先退出 App。
5. **重建库会让明细全量回来**。裁剪只动数据库，`events.jsonl` 里的历史事件一条没少，
   所以从日志重建一次就是全量；裁剪要重新跑一遍。
6. **`event_observations` 的时间列不是事件时间**。10-22 重建后所有事件都是那时重新
   观测的，`observed_at` 全在 7 月以后，按它裁不掉任何东西，只能靠「父事件已删」的
   孤行清理兜底（脚本里已经做了）。

## 回灌

```bash
# 单表回灌（示例：把 2026-07 以前的工具调用明细放回去）
zstd -dc normalized_events-before-2026-07-01.jsonl.zst > /tmp/ne.jsonl
```

每行是一条完整记录，列名与表结构一一对应（归档时剥掉了分页用的 `__rowid`）。
回灌前先停 App，用 `INSERT OR IGNORE` 逐行写回，再 `PRAGMA wal_checkpoint(TRUNCATE)`。
