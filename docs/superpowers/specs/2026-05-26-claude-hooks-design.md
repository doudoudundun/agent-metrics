# Claude Hooks Metrics Design

## Goal

将当前 `agent-metrics` 项目从以 wrapper 为主的采集方式，改造成以 Claude Code 官方 hooks 为主的本地统计插件。第一阶段先落地单写入器方案，直接采集 Claude Code 内部真实工具调用；第二阶段再拆分为总线化架构。

## Scope

本设计覆盖两个连续阶段：

1. 阶段 1：`Hooks + 本地落盘`
2. 阶段 2：`Hooks 总线化`

本设计不覆盖：

- OTel 接入
- token / cost 精确统计
- 团队版部署
- raw payload 的前端展示

## Decisions

### Confirmed Decisions

- 官方接入方式优先采用 `Hooks + 本地落盘`
- 第一阶段完成后通知用户进行手工测试
- 第二阶段再扩展为总线化架构
- wrapper 退出主链路，不再作为保留模式
- hooks 默认安装到全局 Claude 配置
- 同时提供自动安装脚本和手动配置样例
- token 区块在 dashboard 中隐藏
- raw hook payload 只在后端落盘，不在 dashboard 中直接展示
- normalized 事件和 raw payload 同时保留

### Rationale

现有 wrapper 方案只能看到顶层 `claude` 进程，无法稳定拿到 Claude Code 内部真实工具调用。Claude Code 官方 hooks 可以直接提供逐次工具事件、tool input/output、duration 和 transcript path，因此第一阶段应尽快切到 hooks，以最小改造成本验证真实工具明细的采集效果。

## Current State

当前系统由三个应用组成：

- `apps/cli`：wrapper 采集入口
- `apps/core`：读取 `data/events/events.jsonl`，入库 SQLite 并暴露 API
- `apps/dashboard`：读取 API 并展示 overview / sessions / tools

当前事件模型支持：

- `session.started`
- `session.ended`
- `tool.called`
- `tool.succeeded`
- `tool.failed`
- `code.edit.applied`

当前 dashboard 已经能展示 sessions、tool ranking、timeline 和代码修改统计，但工具调用来源依赖 wrapper 生成的合成事件，而不是真实 hooks。

## Target Architecture

### Phase 1: Hooks Single Writer

采集链路：

1. Claude Code 官方 hooks 在工具调用前后触发
2. hooks 调用本项目提供的本地 collector 脚本
3. collector 接收官方 hook payload
4. collector 同时写两份数据：
   - `data/hooks/raw/*.jsonl`：原始 hook payload
   - `data/events/events.jsonl`：normalized 事件
5. `apps/core` 继续 ingest normalized 事件
6. `apps/dashboard` 展示真实工具名和 timeline

这个阶段仍然沿用现有 core/dashboard 的读模型，不引入额外常驻解析服务。

### Phase 2: Hooks Bus

采集链路：

1. Claude hooks 只负责写 `data/hooks/raw/*.jsonl`
2. 新增 parser / normalizer 组件消费 raw 数据
3. parser 负责去重、会话归并、事件标准化
4. parser 写入 normalized 事件流和数据库
5. core 读取标准化后的结构

这个阶段的目标是把 ingress、normalization、storage 解耦，为 transcript、OTel、更多 vendor 适配预留边界。

## Phase 1 Functional Design

### 1. Hook Installer

项目提供一键安装脚本，默认把 hooks 注册到全局 Claude 配置。

安装器职责：

- 生成或更新全局 Claude hooks 配置
- 指向本项目的 collector 入口
- 为不同 hook event 注册统一命令
- 避免重复安装
- 提供可读的安装结果输出

同时提供手动配置样例文件，便于用户：

- 人工审查配置
- 手工安装
- 回滚或迁移

### 2. Collector

collector 是阶段 1 的核心入口。它是一个本地 CLI/脚本，由 Claude hooks 直接调用。

collector 的输入：

- hook event type
- 官方 stdin payload 或等价输入
- 运行时上下文

collector 的输出：

- raw payload append 到本地 raw JSONL
- 根据 hook 类型产出 normalized 事件 append 到 `data/events/events.jsonl`

collector 必须满足：

- 追加写入，不覆盖
- 文件不存在时自动创建目录
- 单次 hook 执行要足够快
- 对未知字段保守透传到 raw payload
- 对 payload 缺字段时做容错，不阻塞 Claude Code 主流程

### 3. Raw Storage

raw payload 按 JSONL 落盘，至少保留以下字段：

- `hook_event_name`
- `tool_name`
- `tool_input`
- `tool_response`
- `tool_use_id`
- `duration_ms`
- `transcript_path`
- `session_id` 或可推导会话标识
- `workspace_path`
- 完整原始 payload
- ingest 时间

第一阶段 raw 文件只用于：

- 排查采集是否生效
- 对账 normalized 结果
- 为第二阶段总线化迁移保留原始事实源

第一阶段不要求前端展示 raw 数据。

### 4. Normalized Event Mapping

collector 在第一阶段直接把 hooks 映射成现有事件模型，以减少 core/dashboard 改造面。

建议映射关系：

- `SessionStart` -> `session.started`
- `SessionEnd` -> `session.ended`
- `PreToolUse` -> `tool.called`
- `PostToolUse` -> `tool.succeeded`
- `PostToolUseFailure` -> `tool.failed`

阶段 1 不强求从 hooks 精确生成 `code.edit.applied`。该事件要么：

- 在确认官方 payload 足够表达文件变更时直接生成
- 要么暂时不生成，等阶段 2 再补充更可靠的变更归因

第一阶段优先目标是“真实工具调用明细”，不是代码 diff 归因的完整性。

如果某些工具调用能从 payload 中明确判定修改目标，可继续保守生成 `code.edit.applied`，但不能伪造无法证明的文件级修改。

### 5. Core Changes

`apps/core` 在阶段 1 需要最小改动：

- 支持 hooks 产生的真实工具名
- timeline 中保留更真实的 hook 顺序
- 对可能新增的 metadata 字段预留扩展
- 在 overview 中去掉 token 依赖

不引入 raw 查询 API 作为第一阶段必需项。

### 6. Dashboard Changes

dashboard 在阶段 1 的目标是让用户能“看出 hooks 已经生效”。

必须变化：

- KPI 中移除 `Estimated Tokens`
- tool ranking 展示真实工具名
- session timeline 展示真实内部工具事件

效果标准：

- 能看到 `Read`、`Edit`、`Bash`、`Grep` 等 Claude Code 内部工具名
- 数据不再是单个 `claude` 顶层命令

### 7. Wrapper Retirement

阶段 1 实现完成后，wrapper 不再作为主方案存在。

处理方式：

- README 与启动脚本改为主推 hooks
- CLI 中与 wrapper 强绑定的说明弱化或删除
- 若短期内代码还留在仓库，应明确标注 deprecated，并从主流程移除

用户要求是“直接替换掉 wrapper”，因此最终对外使用路径应只保留 hooks 方案。

## Phase 2 Functional Design

阶段 2 引入专门的 raw -> normalized 解析层。

新增职责：

- 按 `tool_use_id` / session / timestamp 去重
- 将 raw hook 事件与 session 生命周期归并
- 更清晰地区分 ingress 数据与产品数据
- 为未来 transcript / OTel 接入保留统一归一化入口

阶段 2 结束后，推荐结构为：

- ingress：负责接收 hooks 并写 raw
- parser：负责从 raw 构建标准事件
- storage：负责写入 SQLite 或标准事件文件
- presentation：core/dashboard

## Data Model Notes

阶段 1 至少需要为工具事件保留以下扩展能力：

- `tool_use_id`
- `transcript_path`
- `raw_event_path` 或等价 raw 定位信息
- `hook_event_name`

这些字段可以先只存在于 raw 或数据库扩展字段中，不要求第一阶段全部暴露给前端，但必须保证第二阶段可迁移。

## Testing Strategy

### Phase 1 Acceptance

阶段 1 完成后，用户按以下步骤手测：

1. 运行一键安装脚本
2. 检查 Claude 全局配置中是否写入 hooks
3. 在测试仓库启动 Claude Code
4. 人工触发：
   - 读文件
   - 搜索
   - 编辑文件
   - 运行命令
5. 检查：
   - `data/hooks/raw` 是否新增 JSONL 记录
   - `data/events/events.jsonl` 是否新增 normalized 记录
   - dashboard 中是否显示真实内部工具名
   - session timeline 是否和实际操作一致

### Automated Tests

自动化测试至少覆盖：

- collector 能解析 hook payload 并写 raw
- collector 能映射 hooks 到 normalized 事件
- core 能 ingest hooks 生成的 normalized 事件
- dashboard 能渲染真实工具名
- token KPI 被隐藏
- 安装器对全局配置的幂等更新

## Risks

### 1. Hook Payload Shape Drift

Claude Code 官方 hooks payload 未来可能变化。第一阶段要采用保守解析策略：

- raw 全量保留
- normalized 仅依赖稳定字段
- 测试覆盖缺字段情况

### 2. Code Edit Attribution

仅靠 hooks 不一定能稳定还原文件级 diff。第一阶段不能为了延续现有 KPI 而伪造精细修改统计。必要时应接受 `code.edit.applied` 在阶段 1 的覆盖率下降。

### 3. Global Config Mutation

自动安装脚本修改全局 Claude 配置，必须：

- 先读现状
- 幂等更新
- 尽量不破坏已有 hooks
- 提供可读的手动样例和回滚说明

## Rollout Plan

1. 写 spec 与实现计划
2. 实现阶段 1
3. 通知用户手工测试
4. 根据测试反馈修正阶段 1
5. 再实施阶段 2 总线化

## Success Criteria

### Phase 1 Success

- Claude hooks 安装成功
- raw payload 成功落盘
- dashboard 展示真实 Claude Code 内部工具名
- session timeline 与实际工具调用一致
- wrapper 不再是推荐或主路径

### Phase 2 Success

- raw ingress 与 normalized pipeline 解耦
- parser 成为新的标准化入口
- 不破坏阶段 1 已验证通过的 hooks 采集效果

