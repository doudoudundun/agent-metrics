# Working-Tree Regression Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前未提交重构从「方向对、不能用」修到「能打包、数字可信、主界面不比 HEAD 差」，同时保住已经落地的 GET 不触发同步、v2 合约、Desktop 双窗口。

**Architecture:** 分三波。波次 A 只修会让安装包/主界面当场说谎的回归。波次 B 把 HEAD 上用户已经有的能力接回 v2 入口。波次 C 把 overview 切到 canonical，让 KPI / 会话列表 / Widget 走同一套 SessionKey 和时间窗。Vendor 扩枚举（zcode / kimicode / dsh）不回滚代码，只补规格修订，避免拆掉已经接上的源。

**Tech Stack:** TypeScript, Fastify, Electron, React 19, Zod, Vitest, Testing Library。执行时在沙盒跑测试，不要占用仓库文件锁做全量编译。

---

## 三种投入，对应三种收益

不要一次修完 6 条 Critical + 18 条 Important。按「修完能多得到什么」选档。

| 档位 | 大约改动面 | 修完你得到什么 | 不修会继续付出什么 |
|---|---|---|---|
| **A. 能打包、数字不爆**（推荐先做） | Desktop 打包 + Origin/token、Widget 位置、切 scope 闪错数、Cursor 官方双计 | 新 Desktop 安装包能启动；拖 Widget 重启还在；切 Today/Week 不再先显示昨天的数再变空；Cursor token 不再官方+本地叠两遍 | 包装打出来主进程起不来，或 file:// 全 403；KPI 虚高；切时间范围不可信 |
| **B. 主界面不比 HEAD 差** | A + 会话时间线 + SessionKey + 面板 override 或拆掉死控件 + Cursor 本地自动同步 + 开机启动/主窗尺寸/数据根 + pinned 不被 Main 收掉 | 点会话又能看时间线；Today 默认或明确改成近 7 天；Cursor 本地 generation 不用手点 Sync；旧用户数据还在；pin 行为接近旧 peek | 新壳子比旧 orb/dashboard 功能少一截，用户会觉得重构是退步 |
| **C. 同一屏数字对齐规格** | B + overview/trend/tools 读 canonical + 时间窗统一半开区间 + token 单路径 + OpenCode/Codex 身份 | KPI、会话列表、Widget 对得上；非法 usage 隔离而不是静默 0；历史 tool 不再计两次 | 多源同 session_id 时 overview 少计；边界时刻 KPI 和列表差一天 |

**建议：做完 A 再决定 B。** A 的收益是「这套重构能真正跑起来」。B 的收益是「用户不觉得被砍功能」。C 可以单独排期，不挡日常使用。

**明确不做（除非另开任务）：** 回滚 zcode/kimicode/dsh 成四个 vendor（产品 UI 已经当独立源用，回滚比修规格更伤）；拆掉 GET 隔离；把 Desktop 退回四窗口。

---

## 文件地图

波次 A：

- Modify: `apps/desktop/package.json` — `contracts` 进 dependencies；打包 files 带上合约运行时
- Modify: `apps/desktop/scripts/stage-runtime.mjs` — 如需把 contracts/event-schema/zod 打进 runtime
- Modify: `apps/core/src/http-security.ts` — file:// / Origin null + loopback token
- Modify: `apps/core/src/server.ts` / `apps/core/src/app.ts` — 生成并注入 local token
- Modify: `apps/desktop/src/preload-v2.cts` + `apps/dashboard/src/api.ts` — POST 带 token
- Modify: `apps/desktop/src/main-v2.ts` — 读写 `widgetBounds` / `widgetAnchorRatio`
- Modify: `apps/dashboard/src/query-hooks.ts` + `apps/dashboard/src/query-client.ts`
- Modify: `apps/dashboard/src/DashboardPage.tsx` — 切 scope 保持 stale，空态走 loading
- Modify: `apps/core/src/cursor-account-usage.ts` — 官方日用量不要写入加性 usage 表

波次 B：

- Modify: `apps/dashboard/src/DashboardPage.tsx` + `RecentSessionsTable.tsx` + `SessionTimelinePanel.tsx`
- Modify: `apps/core/src/app.ts` — `cursor-ide` 进 light refresh
- Modify: `apps/desktop/src/main-v2.ts` — login item、main bounds、open-main 保持 pinned、数据根迁移
- Modify: `apps/core/src/core-routes.ts` — export 带 scope

波次 C：

- Modify: `apps/core/src/aggregate-queries.ts` + `session-queries.ts` + `canonical-queries.ts`
- Modify: `packages/metrics-engine/src/index.ts`
- Modify: `packages/adapters-opencode/src/opencode.ts` + `packages/adapters-codex/src/codex.ts`
- Modify: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md` 或新增 revision 3 附录（vendor 扩枚举）

---

## 波次 A — 能打包、数字不爆

### Task 1: 打包主进程能解析 contracts

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/scripts/stage-runtime.mjs`（若 asar 仍解析不到 workspace 包）
- Test: `apps/desktop/src/package-target.test.ts` 或新建 `apps/desktop/src/package-files.test.ts`

- [ ] **Step 1: 写失败断言**

断言生产 `package.json` 的 `dependencies` 含 `@agent-metrics/contracts`，且 `build.files` 不只是 `dist/**/*`，或者 staging 清单含 `contracts/dist` 与 `zod`。

- [ ] **Step 2: 最小实现**

把 `@agent-metrics/contracts` 从 `devDependencies` 挪到 `dependencies`。electron-builder 对 workspace 包默认不打进 asar。两种等价修法，选一个：

1. **推荐：** 用 esbuild 把 `src/main-v2.ts` 打成单文件 `dist/main-v2.js`（preload 保持独立 cts 编译）。主进程不再运行时解析 workspace 包。
2. **备选：** `build.files` 增加 `node_modules/@agent-metrics/contracts/**`、`node_modules/@agent-metrics/event-schema/**`、`node_modules/zod/**`。

不要把整个 monorepo `node_modules` 打进去。

- [ ] **Step 3: 沙盒验证**

只跑 desktop 包测试，不在仓库根做全量 `pnpm build`。人工确认 `release` 里主进程启动不再报 `Cannot find package '@agent-metrics/contracts'`。

**收益：** 安装包能起来。不修这条，后面所有 Desktop 修复都是开发态幻觉。

---

### Task 2: 打包 Dashboard 能打到 Core API

**Files:**
- Modify: `apps/core/src/http-security.ts`
- Modify: `apps/core/src/http-security.test.ts`
- Modify: `apps/core/src/server.ts`
- Modify: `apps/desktop/src/preload-v2.cts`
- Modify: `apps/dashboard/src/api.ts`

- [ ] **Step 1: 锁 Origin:null 行为**

在 `http-security.test.ts` 增加：

```ts
it("allows loopback GET from null Origin", async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { host: "127.0.0.1:45183", origin: "null" }
    });
    expect(response.statusCode).toBe(200);
  });
});

it("rejects state-changing requests with null Origin unless token matches", async () => {
  await withApp(async (app) => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { host: "127.0.0.1:45183", origin: "null" }
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: {
        host: "127.0.0.1:45183",
        origin: "null",
        "x-agent-metrics-token": "test-token"
      }
    });
    expect(allowed.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: 实现**

规则定死，不要「任意 Origin 放行」：

- Host 必须是 loopback（已有）。
- GET：`Origin` 缺失、`null`、或 allowlist（`http://127.0.0.1:4173` / `http://localhost:4173`）都允许。
- POST/PUT/PATCH/DELETE：Origin 在 allowlist，或 `X-Agent-Metrics-Token` 等于进程启动时生成的 token。
- `server.ts` 在 listen 前生成 `AGENT_METRICS_LOCAL_TOKEN`（未设置则随机），写入 Core 与 Desktop supervisor 共享的 runtime 配置。preload 把 token 暴露给 renderer 的 `fetch` 包装，或 `api.ts` 从 `window.agentMetricsDesktop` 读。**不要**把 token 放进 URL query。

- [ ] **Step 3: 浏览器开发态回归**

Vite 同端口代理（无跨 Origin）仍应 200。不要把 allowlist 扩成 `*`。

**收益：** 打包 file:// Dashboard 能读 overview / 能点 Sync。和 Task 1 一起，才叫「Windows/macOS packaging still works」。

---

### Task 3: Widget 位置持久化

**Files:**
- Modify: `apps/desktop/src/main-v2.ts`
- Modify: `apps/desktop/src/widget-layout.ts`（如需从 bounds 反推 ratio）
- Test: `apps/desktop/src/widget-layout.test.ts` + `apps/desktop/src/desktop-settings-v2.test.ts`

- [ ] **Step 1: 启动时用 settings.widgetBounds**

`loadSettings` 之后：

```ts
const workArea = getWidgetWorkArea();
if (settings.widgetBounds) {
  widgetAnchorRatio = normalizeWidgetAnchor(settings.widgetBounds, workArea);
}
```

不要写死 `0.5`，除非 bounds 缺失。

- [ ] **Step 2: 拖拽结束和 Reset 写回 collapsed 锚点矩形**

`persistWidgetAnchor(bounds)`：用当前 workArea 算出 collapsed 矩形，写入 `settings.widgetBounds` 和 `widgetDockEdge`，再 `saveDesktopSettingsV2`。`resetWidgetPosition` 必须走同一函数，不要空 save。

- [ ] **Step 3: 测试**

覆盖：legacy orb 垂直中线 → 迁移后的 `widgetBounds` 被 main 读成相同 ratio；拖到下半屏、重启、仍在下半屏。

**收益：** 用户拖过的球不会每次开机弹回屏幕中点。这是旧 orb 最被依赖的行为。

---

### Task 4: 切 time-scope / source 不再闪错数、假空

**Files:**
- Create: `apps/dashboard/src/query-hooks.test.ts`
- Modify: `apps/dashboard/src/query-hooks.ts`
- Modify: `apps/dashboard/src/DashboardPage.tsx`
- Modify: `apps/dashboard/src/DashboardPage.test.tsx`

- [ ] **Step 1: 复现测试**

```tsx
it("keeps previous overview numbers visible while the new scope loads", async () => {
  // 先渲染 day 范围并等到 45,678
  // 把 fetchOverview 改成 pending Promise
  // 点 This Week
  // 断言：仍能看到 45,678，且出现 loading/stale，而不是 No activity
});
```

- [ ] **Step 2: 修 useQuery**

key 变化时：

1. 立刻 `setState` 为 `client.getState(newKey)`。
2. 若新 key 无 data，把**上一 key 的成功 data** 带到新 state，`status: "stale"`（或 `loading` 若从未成功过）。
3. `DashboardPage` 不要用 `toolsQuery.data?.rows ?? []` 当「确定为空」。`status === "loading" | "stale"` 且 `data === null` 时走 loading，不要画 empty。

- [ ] **Step 3: 超时 generation**

`QueryClient` 超时除了 `abort()`，再 `entry.generation += 1`，并清掉 `entry.promise`。迟到 resolve 不得写成 `ready`。

**收益：** 切 Today → This Week 时数字可信。这是用户每天都会碰到的回归；锁它的旧测试已经被删掉，必须补回来。

---

### Task 5: Cursor 官方日用量不要进加性 totals

**Files:**
- Modify: `apps/core/src/cursor-account-usage.ts`
- Modify: `apps/core/src/cursor-account-usage.test.ts`
- Modify: `apps/core/src/app.ts`（停掉对 `persistCursorOfficialDayTokens` 的调用，或改为只写账户面板表）

- [ ] **Step 1: 测试**

插入一条 `cursor-generation` usage 和一条官方日合计。`GET /api/overview?sourceVendor=cursor` 的 `totalTokens` 只含 generation。`GET /api/cursor/account-usage` 仍返回官方配额。

- [ ] **Step 2: 实现**

删除（或不再调用）向 `token_usage_events` / `usage_events` 的 `cursor-official` increment 写入。官方数字只留在 `cursor_account_usage` 表，给 `CursorAccountUsagePanel` 用。

若库里已经有 `cursor-official:*` 行，加一次性 cleanup：按 `event_id LIKE 'cursor-official:%'` 删掉，避免旧双计残留。

**收益：** Cursor 筛选下 KPI 不再「官方日合计 + IDE 明细」。这是这次重构新引入的数据错误，修了用户才敢看 token。

---

## 波次 B — 主界面不比 HEAD 差

### Task 6: 接回会话时间线（带 SessionKey）

**Files:**
- Modify: `apps/dashboard/src/components/RecentSessionsTable.tsx`
- Modify: `apps/dashboard/src/DashboardPage.tsx`
- Modify: `apps/dashboard/src/components/SessionTimelinePanel.tsx`
- Modify: `apps/dashboard/src/DashboardPage.test.tsx`
- Modify: `apps/dashboard/src/api.test.ts`

- [ ] **Step 1:** 行身份改成 `{ sourceInstanceId, sessionId }`，React key 用两者拼接。
- [ ] **Step 2:** 选中后调用 `fetchSessionDetail(sourceInstanceId, sessionId, scope)`。
- [ ] **Step 3:** `SessionTimelinePanel` 改吃 contracts 的 `timeline.rows`，不要再 import `legacy-api` 的数组形状。
- [ ] **Step 4:** `api.test.ts` 不再断言 `GET /api/sessions/ses_1`。

**收益：** 点会话又能看工具/token 时间线。后端路由已经有了，这是纯前端接线，投入小、观感大。

---

### Task 7: 面板 override 要么可用，要么拆掉死控件

**Files:**
- Modify: `apps/dashboard/src/DashboardPage.tsx`
- Modify: `apps/dashboard/src/components/TokenTrendPanel.tsx` / `ToolRankingTable.tsx`

二选一，不要留「能点但无效」：

1. **恢复（推荐，对齐本分支已提交的 time-scope 能力）：** 把 `tokenTrendOverride` / `rankingOverride` state 接回去，独立 query key。
2. **删除：** `override={null}` 的控件从 DOM 拿掉，避免假 UI。

**收益：** 用户不再被无效下拉误导；若选 1，本分支原来卖的 time-scope 能力还在。

---

### Task 8: 默认时间窗做成产品决定，不是静默改掉

**Files:**
- Modify: `apps/dashboard/src/time-scope.ts`
- Modify: `apps/dashboard/src/DashboardPage.test.tsx`
- Modify: `apps/dashboard/src/WidgetPage.tsx`（文案与 Core snapshot 对齐）

- [ ] 若产品要「打开就是今天」：改回 `calendar/day`。
- [ ] 若产品要「打开就是近 7 天」：测试、空态文案、Widget 标题一起改，不要一边 Today 一边 rolling week。

**收益：** 默认视图是故意的，不是重构副作用。

---

### Task 9: Cursor 本地产物重新自动同步

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/src/app.test.ts`

把 `syncCursorArtifacts` 放进 `startSourceLightRefreshLoop` 的任务列表（与 Codex/OpenCode 一样 try/catch 隔离）。`startInitialSync` 不要永远排除 cursor。官方用量循环保持独立。

**收益：** 去掉 GET 同步之后的空洞补上。不点 Sync 也能看到新的 Cursor generation。

---

### Task 10: Desktop 日常行为接回 v2 入口

**Files:**
- Modify: `apps/desktop/src/main-v2.ts`
- Modify: `apps/desktop/src/data-root-migration.ts`（只改调用点）

- [ ] `whenReady` 调用 `migrateLegacyDataRoots` 和 `setLoginItemSettings({ openAtLogin: settings.launchAtLogin })`。
- [ ] 主窗读取/写回 `mainWindowBounds`。
- [ ] `showMainWindow`：仅当当前 mode 是 `expanded` 时应用 `widgetModeAfterOpenMain`；`pinned` 保持 pinned。
- [ ] Widget `handleSync` 对齐 Dashboard：等到 `waitForSyncRuns` 再 refresh。
- [ ] `fetchSnapshot` / `fetchStatus` 接收并转发 `AbortSignal`。
- [ ] Pin 按钮初始值来自 `getSettings().widgetModeOnStartup` 或主进程 push 的 mode，不要本地 `useState(false)`。

**收益：** 开机启动、窗口大小、历史数据路径、钉住小球，这些是每天用的，不是规格边角。

---

### Task 11: 导出跟随当前过滤器

**Files:**
- Modify: `apps/core/src/core-routes.ts`
- Modify: `apps/dashboard/src/api.ts` / `DashboardPage.tsx`

`GET /api/exports/{csv,json}` 走 `resolveRequestScope` + `resolveSourceVendor`，与 `/api/tools` 相同。`buildExportUrl` 带上当前 search params。

**收益：** 页面显示近 7 天，导出不再是全库。

---

## 波次 C — 同一屏数字对齐（可另开）

### Task 12: Overview / trend / tools 改读 canonical

**Files:**
- Modify: `apps/core/src/aggregate-queries.ts`
- Modify: `apps/core/src/session-queries.ts`（source/provider breakdown）
- Modify: `apps/core/src/canonical-queries.ts`
- Modify: `apps/core/src/query-support.ts` — 统一 `[windowStart, windowEnd)`
- Test: `apps/core/src/canonical-queries.test.ts` + `apps/core/src/v2-routes.test.ts`

同一对 `(source_instance_id, session_id)` 在 overview `sessionCount` 和 `/api/sessions` 条数必须相等。边界时刻（正好 `windowEnd`）只被一边算进去的测试必须失败直到 SQL 对齐。

**收益：** 多源、同 session id、切范围时，KPI 和列表终于是同一个系统。这是规格第 9/10 节真正完成的标志，工作量最大，但日常「能不能打开软件」不依赖它。

---

### Task 13: Token 单路径 + adapter 身份

- Overview 对 V2 行调用 `displayedInputTokens`，`InvalidUsageError` 排除该行，不再 `Math.max`。
- 停用 `persistCursorOfficialDayTokens` 后，registry 不必再把 `cursor-official` 当 increment 总量。
- OpenCode：非法/歧义 gross 进 diagnostic，不要 `cacheRead > input` 才折叠。
- Codex：逐条 `toNormalizedEventV2`；usage `event_id` 不要绑累计 `total_tokens`。
- Kimi：增量续读重建 parse state。
- 历史 tool pairing：有明确 start+finish 的 legacy 对合成一条 `tool_calls`。

**收益：** token 不再随查询入口变；非法行可修而不是静默丢。

---

### Task 14: Vendor 扩枚举写成规格修订，不回滚

在规格 revision 3（或 ADR）写明：`SourceVendor` 现为 `claude-code | opencode | zcode | kimicode | dsh | codex | cursor`。ZCode 不再伪装成 OpenCode。迁移 `003-split-zcode-vendor` 保留。

**收益：** 实现和文档一致，避免下次审查再把「产品已接上的源」判成非法。

---

## 波次对照：修完 vs 现在

| 用户能感知的事 | 现在 | 只做 A | A+B | A+B+C |
|---|---|---|---|---|
| 安装包能打开 | 否（contracts + Origin） | 是 | 是 | 是 |
| 切 Today/Week 数字可信 | 否，闪错再假空 | 是 | 是 | 是 |
| Cursor token 不虚高 | 否 | 是 | 是 | 是 |
| Widget 拖完还在 | 否 | 是 | 是 | 是 |
| 点会话看时间线 | 否 | 否 | 是 | 是 |
| 面板独立时间范围 | 假控件 | 否 | 是或拆掉 | 是或拆掉 |
| Cursor 本地自动刷新 | 否 | 否 | 是 | 是 |
| 旧数据目录还能看见 | 部分用户否 | 否 | 是 | 是 |
| KPI 和会话列表条数一致 | 多源时否 | 否 | 否 | 是 |

---

## 自检

- Critical 6 条都有 Task：时间线=6，Origin=2，官方双计=5，contracts=1，Widget 位置=3，切 scope=4。
- GET 隔离、双窗口、v2 合约 **不改回去**。
- 没有「以后再补错误处理」之类占位；Vendor 选择已写死为「改规格不回滚」。
- 测试命令按包跑（`apps/core`、`apps/dashboard`、`apps/desktop`），不要在用户工作区抢文件锁做全量编译。
