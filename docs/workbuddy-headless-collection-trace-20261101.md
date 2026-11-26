# WorkBuddy headless 用量漏采跟踪（2026-11-01）

## 结论与范围

确认是采集漏洞：同时漏掉 WorkBuddy bundled CLI 的日志目录和原生日志时间格式。
已修复工作区源码，完成真实日志的隔离采集与 SQLite 投影。用户随后授权历史回填、重新打包和启动，
这些操作已完成，详情见文末。未提交或推送代码，保留了工作区原有未提交修改。

## 实际证据

- Relay job：`a5616121-2f1c-4f16-acf7-cd4a25832ba8`，跟踪时已由其他操作进入 canceled；本次没有取消任务或发起新模型调用。
- 原生 session：`01a19792-1833-7ba7-a780-91339af59661`。
- 原生日志：`/Users/chengzi/.workbuddy/logs/2026-11-01/any-subagent__d0b05eecf2c6db89e315429f471657aa.log`。
- 日志 SHA-256：`6a0861577ae385715a3c8670af93692099b125ad267597b5de7ac1aebf48e0ea`（回放前后相同）。
- 请求时间：2026-11-01 22:45:03.483–23:04:28.800，Asia/Shanghai。
- 桌面运行实例实际数据库：`/Users/chengzi/Library/Application Support/Agent Metrics/agent-metrics-data/data/sqlite/metrics.sqlite`。
- 该数据库查询目标 session 的 `usage_events` 为 **0 行**；原生日志为 **113 个唯一 message ID**。
- 未发现目标 session 的 `.workbuddy/projects` transcript；当天 `.codebuddy/logs` 无相应文件。

Relay 启动参数含 `--no-session-persistence`；这只解释 transcript 缺失，不能据此推断没有用量或没有请求日志。
原生日志时间戳实际形如 `[11/1/2026, 10:45:03 PM.483]`。

## 修复

1. CLI 日志采集默认同时发现 `.codebuddy/logs`、`.workbuddy/logs`，沿用 home 配置覆盖。
2. 显式传入 `logRoot` 时仍仅扫描指定目录；相同根目录合并，沿用原有游标和 message-ID 账本去重。
3. 解析器增加上述 en-US 时间格式，覆盖 AM、PM、午夜和中午；保留既有年/月/日时间格式。
4. 文档纠正了“关闭 transcript 就不留任何字节”的过度概括。

## 隔离回放

只复制原生日志到 `/tmp/agent-metrics-workbuddy-trace-20261101/` 下的独立输入目录，
原始内容没有返回聊天。临时事件日志、游标、账本和数据库均与桌面数据隔离。

目标 session 的 `usage_events` 与原生日志逐请求聚合一致：

| 字段 | 回放结果 |
| --- | ---: |
| 唯一请求 / 数据库用量行 | 113 |
| gross input | 18,271,722 |
| output | 72,814 |
| input + output | 18,344,536 |
| cache read（包含于 gross input） | 18,123,520 |
| cache write | 0 |
| 数值积分字段 | 未提供 |

同文件还含另一个 session，因此整文件首次采集为 226 次请求，目标 session 为其中 113 次。
第二次采集新增 0 次，重复投影新增 0 行，所有行均满足缓存量不超过 gross input。

Relay stdout 与原生日志的 message ID 集合相同，但 Relay 累计为 input 17,020,278、output 66,919、
cache read 16,948,224、cache creation 72,054。两种上报口径/完整性差异未查清，不能互相替代、相加或当作积分账单。

## 验证与保留限制

- CLI 日志测试：21 项通过。
- WorkBuddy transcript/timing/sync 测试：31 项通过。
- core WorkBuddy 去重与 app 集成测试：36 项通过。
- core 及其依赖构建通过；时间解析改动后的 CLI 日志 adapter 构建通过。
- 真实日志隔离回放、重复采集、重复投影和缓存约束断言通过。
- 运行库只读 audit 检出 `codebuddy-log` source_stall 警告；其它来源的既有警告未纳入本次修复。
- 本节记录最初只读跟踪阶段：当时未做 GUI 验收、桌面重新打包/重启、实际积分账单核对或运行库回填。后续交付见下节。

本地详细证据：`/tmp/agent-metrics-workbuddy-trace-20261101/summary.json`、
`replay-summary.json`、`trace.js`、`replay.mjs`、`live-audit.json`。
临时目录可能被系统清理；来源路径、哈希和关键结果已保存在本文。

## 授权后的历史恢复与桌面交付（同日 23:20–23:27）

旧应用先通过菜单正常退出。原运行数据以 APFS copy-on-write 完整备份至：

`/Users/chengzi/Library/Application Support/Agent Metrics/agent-metrics-data/backups/workbuddy-history-20261101-232048/`

备份数据库 quick_check 为 ok。回填使用新桌面包自带的 Node 22 与 adapter / projector，
按原账本跳过已收集记录，将新增事件追加到原事件日志并正常投影，未直接改写已有用量。

- 扫描本机保留的 54 个日志文件，约 124.4 MB。WorkBuddy 48 个，日期覆盖 2026-10-29 至 11-01；另 6 个 CodeBuddy 日志未发现 qua.end 用量。
- 审计冻结时有 1,482 条 qua.end，其中 4 条零 Token 有意跳过，其余 1,478 个唯一请求均成功解析，无格式或身份字段漏解析。
- 已有 520 个请求被账本去重跳过，实际补回 958 次请求，WorkBuddy 用量行 11,367 → 12,325，会话 49 → 70。
- 新增 gross input 109,911,635、output 631,987、cache read 108,492,416；缓存包含在 gross input 内，不可再相加。原生日志没有数值积分字段，积分仍未知。
- 按冻结的 1,478 个 session/message ID 复核：覆盖 1,478/1,478，缺失 0，重复 0，Token/缓存字段不匹配 0。
- 第二次补采新增 0，重复投影未新增，运行数据库 quick_check 为 ok。
- 全项目 build、macOS arm64 包验证、包内 Core health 和页面资源冒烟均通过。新包实际包含双目录扫描与 en-US 时间解析修复。
- 已启动新包：`apps/desktop/release/mac-arm64/AgentMetrics.app`；主进程 65561、Core 65570。健康 API 正常，WorkBuddy 两个 adapter 均 ready，无错误或连续失败。
- 实际主窗口刷新后显示 Live and up to date，WorkBuddy 今日显示 106,913,007 tokens，18 sessions；最近 7 天显示 599,720,356 tokens，46 sessions。验证后恢复 Today + All sources。

GUI 限制：首次加载曾短暂显示 Core offline / Failed to fetch，Cmd+R 刷新后恢复；未验证能否自动恢复。
悬浮组件的独立视觉行为未验收。金额为已有定价逻辑的估算，未核对官方积分账单。日志已清理的更早历史无法凭本次日志保证恢复。

持久化交付证据：`docs/superpowers/notes/evidence/workbuddy-history-recovery-macos-20261101.json`。
旧包由打包脚本移至 release 下的 `.cleaned-mac-arm64-*` 目录保留。
