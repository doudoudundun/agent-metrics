# Agent Metrics Card

独立的桌面统计组件，显示今天的用量。它不置顶、不显示独立任务栏图标，其他窗口可以正常覆盖它。组件使用独立进程和设置。

## 启动

先确保本地 Core 已在运行（默认 `http://127.0.0.1:45183`），然后：

```powershell
corepack pnpm --filter @agent-metrics/desktop-card dev
```

或在仓库根目录：

```powershell
corepack pnpm dev:desktop-card
```

关闭卡片只会退出这个独立应用，不影响主桌面应用。

## 数据范围

默认读取 `GET /api/overview?mode=calendar&range=day&sourceVendor=all`，即本地自然日的 **Today / 全部来源**，随日期变化刷新。

可通过环境变量指向已运行的 Core：

- `AGENT_METRICS_CORE_PORT`（默认 `45183`）
- `AGENT_METRICS_CORE_API_BASE_URL`（完整基址，优先）
- `AGENT_METRICS_LOCAL_TOKEN`（可选；主进程只在已有环境变量时附带 `X-Agent-Metrics-Token`，不会写入卡片设置或界面）

Core 不可用时卡片会显示明确状态，而不会填入截图里的示例数字。

真实 Electron 启动截图在 `evidence/card-ready.png` 与 `evidence/card-toolbar.png`，验证记录在 `evidence/acceptance-2026-10-28.json`。

## 窗口行为

- 无边框、可拖动；不置顶，不抢焦点（Windows），隐藏独立任务栏图标
- 悬停显示刷新 / 关闭
- 拖动时可自由跨屏；启动或显示器变化时恢复到可见工作区，记住所在屏幕和位置
- 独立设置文件：`%APPDATA%/Agent Metrics Card/card-settings.json`
- 每 30 秒刷新；请求不会重叠，关闭时取消请求和计时器，并等待设置保存。

## 黑色桌面样式

组件使用透明底、灰白数字和低饱和标签，不显示外框或浅色区块。操作按钮仅在悬停时出现。黑色背景下的真实数据预览见 `evidence/card-black-desktop.png`，渲染验证记录见 `evidence/dark-theme-2026-10-28.json`。
