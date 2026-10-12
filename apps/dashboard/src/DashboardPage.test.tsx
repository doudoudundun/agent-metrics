import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExportUrl,
  fetchCursorAccountUsage,
  fetchOverview,
  fetchSessionDetail,
  fetchSessions,
  fetchSyncRun,
  fetchSyncStatus,
  fetchTokenTrend,
  fetchTools,
  triggerSync
} from "./api";
import { DashboardPage, deriveDashboardStatus, formatDashboardStatusLabel } from "./DashboardPage";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const apiMocks = vi.hoisted(() => ({
  fetchOverview: vi.fn(),
  fetchTokenTrend: vi.fn(),
  fetchTools: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionDetail: vi.fn(),
  fetchCursorAccountUsage: vi.fn(),
  fetchSyncRun: vi.fn(),
  fetchSyncStatus: vi.fn(),
  buildExportUrl: vi.fn(),
  triggerSync: vi.fn()
}));

vi.mock("./api", () => ({
  ...apiMocks,
  triggerSync: apiMocks.triggerSync
}));

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "styles.css");

describe("DashboardPage", () => {
  beforeEach(() => {
    delete window.agentMetricsDesktop;
    vi.mocked(fetchOverview).mockReset();
    vi.mocked(fetchTokenTrend).mockReset();
    vi.mocked(fetchTools).mockReset();
    vi.mocked(fetchSessions).mockReset();
    vi.mocked(fetchSessionDetail).mockReset();
    vi.mocked(fetchCursorAccountUsage).mockReset();
    vi.mocked(fetchSyncRun).mockReset();
    vi.mocked(fetchSyncStatus).mockReset();
    vi.mocked(triggerSync).mockReset();
    apiMocks.buildExportUrl.mockReset();
    seedApiMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the operational workspace with overview metrics and export links", async () => {
    const view = render(<DashboardPage />);

    expect(screen.getByRole("heading", { name: "Operational workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /agent metrics/i })).not.toBeInTheDocument();

    const overviewRegion = await screen.findByRole("region", {
      name: "Overview metrics for Today"
    });
    expect(within(overviewRegion).getByText("45,678")).toBeInTheDocument();
    const statusStrip = screen.getByRole("region", { name: "Operational status summary" });
    expect(within(statusStrip).getByText("Est. cost $12.34")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/exports/csv");
    expect(screen.getByRole("link", { name: "Export JSON" })).toHaveAttribute("href", "/api/exports/json");
    expect(fetchSyncStatus).toHaveBeenCalled();

    view.unmount();
  });

  it("filters dashboard requests by source without a full-page error state", async () => {
    vi.mocked(fetchOverview).mockImplementation(async (_, sourceVendor) => ({
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T16:00:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      sessionCount: sourceVendor === "codex" ? 1 : 3,
      turnCount: sourceVendor === "codex" ? 0 : 24,
      responseCount: sourceVendor === "codex" ? 0 : 12,
      totalTokens: sourceVendor === "codex" ? 150 : 45678,
      inputTokens: sourceVendor === "codex" ? 100 : 22345,
      outputTokens: sourceVendor === "codex" ? 40 : 19876,
      cacheReadTokens: sourceVendor === "codex" ? 10 : 2345,
      cacheCreationTokens: sourceVendor === "codex" ? 0 : 1112,
      tokensByModel: [],
      totalToolCalls: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      startedOnlyExecutions: 0,
      successRate: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0,
      sourceBreakdown:
        sourceVendor === "codex"
          ? [{ sourceVendor: "codex", sessionCount: 1, turnCount: 0, totalTokens: 150, toolCalls: 0, costUsd: 0.15 }]
          : [{ sourceVendor: "claude-code", sessionCount: 3, turnCount: 24, totalTokens: 45678, toolCalls: 12, costUsd: 12.34 }],
      providerBreakdown: [],
      totalCostUsd: sourceVendor === "codex" ? 0.15 : 12.34
    }));

    const view = render(<DashboardPage />);
    expect(await screen.findByRole("region", { name: "Overview metrics for Today" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));

    expect(await screen.findByText("150")).toBeInTheDocument();
    expect(fetchOverview).toHaveBeenCalledWith(
      { mode: "calendar", range: "day" },
      "codex",
      expect.any(AbortSignal)
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Others" }).parentElement as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    await waitFor(() => expect(fetchOverview).toHaveBeenCalledWith(
      { mode: "calendar", range: "day" },
      "claude-code",
      expect.any(AbortSignal)
    ));

    fireEvent.click(screen.getByRole("button", { name: /DSH/ }));
    await waitFor(() => expect(fetchOverview).toHaveBeenCalledWith(
      { mode: "calendar", range: "day" },
      "dsh",
      expect.any(AbortSignal)
    ));

    view.unmount();
  });

  it("orders source chips by usage under the current scope", async () => {
    vi.mocked(fetchOverview).mockResolvedValue({
      ...buildReadyOverview(),
      sourceBreakdown: [
        { sourceVendor: "kimicode", sessionCount: 5, turnCount: 40, totalTokens: 900000, toolCalls: 500, costUsd: 9 },
        { sourceVendor: "mimo", sessionCount: 3, turnCount: 13, totalTokens: 48000, toolCalls: 55, costUsd: 0.48 },
        { sourceVendor: "codex", sessionCount: 1, turnCount: 0, totalTokens: 9000, toolCalls: 7, costUsd: 0.09 },
        { sourceVendor: "cursor", sessionCount: 0, turnCount: 1, totalTokens: 0, toolCalls: 4, costUsd: 0 },
        { sourceVendor: "claude-code", sessionCount: 2, turnCount: 5, totalTokens: 100, toolCalls: 10, costUsd: 0.001 }
      ]
    });

    const view = render(<DashboardPage />);
    await screen.findByRole("region", { name: "Overview metrics for Today" });

    expect(readSourceChips()).toEqual({
      primary: ["All sources", "Kimi Code", "MiMo", "Codex", "Claude Code", "Cursor", "Others"],
      others: ["ZCode", "OpenCode", "DSH"]
    });
    expect(screen.getByRole("button", { name: /Kimi Code/ })).toHaveTextContent("$9.00");
    expect(screen.getByRole("button", { name: "All sources" })).not.toHaveTextContent("$");

    view.unmount();
  });

  it("keeps source chip order stable when a source is selected", async () => {
    const allBreakdown = [
      { sourceVendor: "kimicode" as const, sessionCount: 5, turnCount: 40, totalTokens: 900000, toolCalls: 500, costUsd: 9 },
      { sourceVendor: "mimo" as const, sessionCount: 3, turnCount: 13, totalTokens: 48000, toolCalls: 55, costUsd: 0.48 },
      { sourceVendor: "codex" as const, sessionCount: 1, turnCount: 0, totalTokens: 9000, toolCalls: 7, costUsd: 0.09 },
      { sourceVendor: "cursor" as const, sessionCount: 0, turnCount: 1, totalTokens: 0, toolCalls: 4, costUsd: 0 }
    ];
    // A filtered overview only ever contains the selected source, so ranking the
    // chips from it would promote whichever chip is selected to first place.
    vi.mocked(fetchOverview).mockImplementation(async (_scope, sourceVendor) => ({
      ...buildReadyOverview(),
      sourceBreakdown:
        sourceVendor === "all"
          ? allBreakdown
          : allBreakdown.filter((row) => row.sourceVendor === sourceVendor)
    }));

    const view = render(<DashboardPage />);
    await screen.findByRole("region", { name: "Overview metrics for Today" });

    const chipLabels = ["All sources", "Kimi Code", "MiMo", "Codex", "Cursor", "ZCode"];
    const readChips = (): (string | undefined)[] => {
      const toolbar = screen.getByRole("toolbar", { name: "Dashboard source filter" });
      return within(toolbar)
        .getAllByRole("button")
        .map((button) => readChipLabel(button))
        .filter((label) => label !== undefined && chipLabels.includes(label));
    };

    const expected = ["All sources", "Kimi Code", "MiMo", "Codex", "Cursor", "ZCode"];
    expect(readChips()).toEqual(expected);

    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    await waitFor(() =>
      expect(fetchOverview).toHaveBeenCalledWith(
        { mode: "calendar", range: "day" },
        "codex",
        expect.any(AbortSignal)
      )
    );

    expect(readChips()).toEqual(expected);

    view.unmount();
  });

  it("passes the visual guard: no hero shell and no nested dashboard cards", async () => {
    const view = render(<DashboardPage />);

    await screen.findByRole("region", { name: "Overview metrics for Today" });

    const page = screen.getByRole("main");
    expect(page).toHaveClass("dashboard-page");
    expect(page.querySelector(".hero-panel")).toBeNull();
    expect(page.querySelector(".panel .panel")).toBeNull();
    expect(page.querySelector(".kpi-card .panel")).toBeNull();

    const stylesheet = readFileSync(stylesPath, "utf8");
    const dashboardSection = extractDashboardPageStyles(stylesheet);
    expect(dashboardSection).not.toMatch(/radial-gradient/i);
    expect(dashboardSection).not.toMatch(/\bbokeh\b/i);
    expect(dashboardSection).toMatch(/box-shadow:\s*none/i);

    view.unmount();
  });

  it("passes accessibility checks for the ready-state workspace", async () => {
    const view = render(<DashboardPage />);

    await screen.findByRole("region", { name: "Overview metrics for Today" });

    const results = await axe.run(view.container, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa"]
      }
    });

    const seriousViolations = results.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    );
    expect(seriousViolations).toEqual([]);

    view.unmount();
  });

  describe("health status fixtures", () => {
    it("renders loading status with accessible health chip and state copy", async () => {
      vi.mocked(fetchOverview).mockImplementation(() => new Promise(() => undefined));

      const view = render(<DashboardPage />);

      const chip = screen.getByRole("status", { name: "Dashboard status: Loading metrics" });
      expect(chip).toHaveTextContent("Loading metrics");
      expect(chip).toHaveClass("health-chip--loading");

      const state = screen.getByText("Waiting for the local metrics core.").closest("section");
      expect(state).toHaveAttribute("aria-live", "polite");
      expect(within(state as HTMLElement).getByText("Loading metrics")).toBeInTheDocument();

      await expectAxeClean(view.container);

      view.unmount();
    });

    it("renders empty status when the scoped overview has zero activity", async () => {
      vi.mocked(fetchOverview).mockResolvedValue(buildZeroOverview());

      const view = render(<DashboardPage />);

      const chip = await screen.findByRole("status", {
        name: "Dashboard status: No activity in this scope"
      });
      expect(chip).toHaveClass("health-chip--empty");
      expect(screen.getByRole("region", { name: "Overview metrics for Today" })).toBeInTheDocument();

      await expectAxeClean(view.container);

      view.unmount();
    });

    it("renders syncing status while sync is in flight", async () => {
      vi.mocked(triggerSync).mockImplementation(() => new Promise(() => undefined));

      const view = render(<DashboardPage />);
      await screen.findByRole("region", { name: "Overview metrics for Today" });

      fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));

      const chip = await screen.findByRole("status", { name: "Dashboard status: Syncing sources" });
      expect(chip).toHaveClass("health-chip--syncing");

      view.unmount();
    });

    it("renders ready status with live overview strip", async () => {
      const view = render(<DashboardPage />);

      const chip = await screen.findByRole("status", { name: "Dashboard status: Live and up to date" });
      expect(chip).toHaveClass("health-chip--ready");
      expect(screen.getByRole("region", { name: "Operational status summary" })).toBeInTheDocument();

      await expectAxeClean(view.container);

      view.unmount();
    });

    it("renders stale status after a refresh failure retains overview data", async () => {
      let calls = 0;
      vi.mocked(fetchOverview).mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return buildReadyOverview();
        }
        throw new Error("Refresh failed");
      });
      vi.mocked(triggerSync).mockResolvedValue({
        requestId: "req_stale",
        acceptedAt: "2026-05-27T10:30:00.000Z",
        runs: [{ adapterInstanceId: "claude", runId: "run_1", disposition: "queued" }]
      });

      const view = render(<DashboardPage />);
      await screen.findByRole("status", { name: "Dashboard status: Live and up to date" });

      fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));

      const chip = await screen.findByRole("status", { name: "Dashboard status: Showing stale data" });
      expect(chip).toHaveClass("health-chip--stale");
      expect(screen.getByRole("region", { name: "Operational status summary" })).toBeInTheDocument();

      view.unmount();
    });

    it("renders offline status when overview cannot be reached", async () => {
      vi.mocked(fetchOverview).mockRejectedValue(new Error("Core unreachable"));

      const view = render(<DashboardPage />);

      const chip = await screen.findByRole("status", { name: "Dashboard status: Metrics core offline" });
      expect(chip).toHaveClass("health-chip--offline");
      expect(screen.getByText("Core unreachable")).toBeInTheDocument();
      const state = screen.getByText("Core unreachable").closest("section");
      expect(state).toHaveAttribute("aria-live", "polite");
      expect(within(state as HTMLElement).getByText("Metrics core offline")).toBeInTheDocument();

      await expectAxeClean(view.container);

      view.unmount();
    });

    it("maps error status with retained overview data to Overview unavailable", () => {
      const status = deriveDashboardStatus("error", { sessionCount: 3, totalTokens: 100 }, [], false);
      expect(formatDashboardStatusLabel(status)).toBe("Overview unavailable");
    });
  });

  it("keeps keyboard tab order aligned with top bar and filter controls", async () => {
    const view = render(<DashboardPage />);
    await screen.findByRole("region", { name: "Overview metrics for Today" });

    const chrome = document.createElement("div");
    const topbar = screen.getByRole("main").querySelector(".dashboard-topbar__actions");
    const filters = screen.getByRole("region", { name: "Dashboard filters" });
    const footer = screen.getByRole("main").querySelector(".dashboard-footer");
    expect(topbar).not.toBeNull();
    expect(footer).not.toBeNull();
    chrome.append(topbar!.cloneNode(true), filters.cloneNode(true), footer!.cloneNode(true));

    const tabStops = collectTabStops(chrome);
    expect(tabStops.map((element) => element.textContent?.trim())).toEqual([
      "Sync sources",
      "",
      "",
      "Today",
      "This Week",
      "This Month",
      "Last 24 Hours",
      "Last 7 Days",
      "Last 30 Days",
      "All Time",
      "All sources",
      "Claude Code$12.34",
      "MiMo",
      "ZCode",
      "Kimi Code",
      "Codex",
      "Others",
      "Cursor",
      "OpenCode",
      "DSH",
      "Export CSV",
      "Export JSON"
    ]);

    const liveStops = [
      ...collectTabStops(topbar as HTMLElement),
      ...collectTabStops(filters),
      ...collectTabStops(footer as HTMLElement)
    ];
    liveStops[0]?.focus();
    expect(document.activeElement).toBe(liveStops[0]);
    for (let index = 0; index < liveStops.length - 1; index += 1) {
      liveStops[index + 1]?.focus();
      expect(document.activeElement).toBe(liveStops[index + 1]);
    }

    view.unmount();
  });

  it("waits for accepted sync runs to finish before refreshing dashboard data", async () => {
    let resolveRun: (value: ReturnType<typeof buildSyncRun>) => void = () => {
      throw new Error("Sync run resolver was not initialized.");
    };
    vi.mocked(fetchSyncRun).mockImplementation(
      () => new Promise<ReturnType<typeof buildSyncRun>>((resolve) => {
        resolveRun = resolve;
      })
    );

    const view = render(<DashboardPage />);
    await screen.findByRole("region", { name: "Overview metrics for Today" });
    // All sources shares the overview response with the source chips.
    expect(fetchOverview).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
    await waitFor(() => expect(fetchSyncRun).toHaveBeenCalledWith("run_seed", expect.any(AbortSignal)));
    expect(fetchOverview).toHaveBeenCalledTimes(1);

    resolveRun(buildSyncRun("run_seed", "succeeded"));
    await waitFor(() => expect(fetchOverview).toHaveBeenCalledTimes(2));

    view.unmount();
  });

  it("queries overview with a custom local date range", async () => {
    const view = render(<DashboardPage />);
    await screen.findByRole("region", { name: "Overview metrics for Today" });

    const start = screen.getByLabelText("Custom range start") as HTMLInputElement;
    const end = screen.getByLabelText("Custom range end") as HTMLInputElement;
    expect(start).toBeInTheDocument();
    fireEvent.change(start, { target: { value: "2026-08-01" } });
    fireEvent.change(end, { target: { value: "2026-08-07" } });

    await waitFor(() => {
      expect(fetchOverview).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "custom",
          startAt: expect.any(String),
          endAt: expect.any(String)
        }),
        "all",
        expect.any(AbortSignal)
      );
    });

    view.unmount();
  });

  it("keeps data visible and reports terminal sync-run failures", async () => {
    vi.mocked(fetchSyncRun).mockResolvedValue(buildSyncRun("run_seed", "failed"));

    const view = render(<DashboardPage />);
    await screen.findByRole("region", { name: "Overview metrics for Today" });

    fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Fixture failure");
    expect(screen.getByRole("region", { name: "Operational status summary" })).toBeInTheDocument();

    view.unmount();
  });

  it("keeps previous overview numbers visible while the new scope loads", async () => {
    let resolveWeek: (value: ReturnType<typeof buildReadyOverview>) => void = () => {
      throw new Error("Overview resolver was not initialized.");
    };
    const weekOverview = new Promise<ReturnType<typeof buildReadyOverview>>((resolve) => {
      resolveWeek = resolve;
    });
    vi.mocked(fetchOverview).mockImplementation(async (scope) => {
      if (scope?.mode === "calendar" && scope.range === "week") {
        return weekOverview;
      }
      return buildReadyOverview();
    });

    const view = render(<DashboardPage />);
    expect((await screen.findAllByText("45,678")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "This Week" }));

    expect(screen.getAllByText("45,678").length).toBeGreaterThan(0);
    expect(screen.queryByText("No activity in this scope.")).not.toBeInTheDocument();

    resolveWeek({
      ...buildReadyOverview(),
      totalTokens: 99
    });
    expect(await screen.findByText("99")).toBeInTheDocument();

    view.unmount();
  });

  it("loads a session timeline using sourceInstanceId and sessionId", async () => {
    const view = render(<DashboardPage />);
    await screen.findByRole("region", { name: "Overview metrics for Today" });

    fireEvent.click(screen.getByRole("button", { name: "ses_1" }));

    await waitFor(() =>
      expect(fetchSessionDetail).toHaveBeenCalledWith(
        "claude:default",
        "ses_1",
        { mode: "calendar", range: "day" },
        50,
        expect.any(AbortSignal)
      )
    );
    expect(await screen.findByText("Session started")).toBeInTheDocument();

    view.unmount();
  });
});

function seedApiMocks(): void {
  vi.mocked(fetchOverview).mockResolvedValue(buildReadyOverview());
  vi.mocked(fetchTokenTrend).mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: [
      {
        bucketStart: "2026-05-27T00:00:00.000Z",
        label: "05-27 08:00",
        totalTokens: 15000,
        inputTokens: 7000,
        outputTokens: 5000,
        cacheReadTokens: 2000,
        cacheCreationTokens: 1000,
        cacheHitRate: 0.2
      }
    ]
  });
  vi.mocked(fetchTools).mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]
  });
  vi.mocked(fetchSessions).mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: [
      {
        sessionId: "ses_1",
        sourceInstanceId: "claude:default",
        workspacePath: "D:/projects/dev/agent-metrics",
        sourceVendor: "claude-code",
        sourceAdapters: ["claude-transcript"],
        providerId: "anthropic",
        providerHost: null,
        turnCount: 14,
        totalTokens: 45678,
        lastModel: "gpt-5-codex",
        lastActivityAt: "2026-05-27T10:00:00.000Z"
      }
    ],
    nextCursor: null
  });
  vi.mocked(fetchSyncStatus).mockResolvedValue({
    generatedAt: "2026-05-27T10:30:00.000Z",
    shuttingDown: false,
    adapters: [{
      adapterInstanceId: "claude",
      sourceInstanceId: "claude:default",
      sourceAdapter: "claude-transcript",
      sourceVendor: "claude-code",
      status: "ready",
      activeRunId: null,
      pendingRunId: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastSuccessfulAt: "2026-05-27T10:00:00.000Z",
      nextScheduledAt: null,
      lastError: null,
      consecutiveFailures: 0
    }]
  });
  vi.mocked(fetchCursorAccountUsage).mockResolvedValue(null);
  vi.mocked(fetchSessionDetail).mockResolvedValue(buildSessionDetail());
  vi.mocked(fetchSyncRun).mockImplementation(async (runId) => buildSyncRun(runId, "succeeded"));
  vi.mocked(buildExportUrl).mockImplementation((format: "csv" | "json") => `/api/exports/${format}`);
  vi.mocked(triggerSync).mockResolvedValue({
    requestId: "req_seed",
    acceptedAt: "2026-05-27T10:30:00.000Z",
    runs: [{ adapterInstanceId: "claude", runId: "run_seed", disposition: "queued" }]
  });
}

function buildSessionDetail() {
  return {
    mode: "calendar" as const,
    range: "day" as const,
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    sourceInstanceId: "claude:default",
    sessionId: "ses_1",
    workspacePath: "D:/projects/dev/agent-metrics",
    sourceVendor: "claude-code" as const,
    sourceAdapters: ["claude-transcript" as const],
    context: {
      executionPath: null,
      skillsLoaded: false,
      skillNames: []
    },
    timeline: {
      rows: [
        {
          eventId: "evt_1",
          createdAt: "2026-05-25T08:00:00.000Z",
          type: "session.started" as const,
          sourceVendor: "claude-code" as const,
          sourceAdapters: ["claude-transcript" as const],
          toolCallId: null,
          toolName: null,
          status: null,
          durationMs: null,
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: null,
          deletions: null,
          promptId: null,
          promptChars: null,
          messageId: null,
          model: null,
          stopReason: null,
          responseChars: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          totalTokens: null,
          usageSource: null
        }
      ],
      nextCursor: null
    }
  };
}

function buildSyncRun(runId: string, status: "succeeded" | "failed" | "aborted" | "syncing") {
  const terminal = status !== "syncing";
  return {
    runId,
    adapterInstanceId: "claude",
    status,
    acceptedAt: "2026-05-27T10:30:00.000Z",
    startedAt: "2026-05-27T10:30:01.000Z",
    completedAt: terminal ? "2026-05-27T10:30:02.000Z" : null,
    discoveredRecords: 0,
    committedUniqueEvents: 0,
    projectedUniqueEvents: 0,
    projectionWatermark: null,
    error: status === "failed" ? { code: "SYNC_FAILED", summary: "Fixture failure" } : null
  };
}

function buildReadyOverview() {
  return {
    mode: "calendar" as const,
    range: "day" as const,
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    sessionCount: 3,
    turnCount: 24,
    responseCount: 12,
    totalTokens: 45678,
    inputTokens: 22345,
    outputTokens: 19876,
    cacheReadTokens: 2345,
    cacheCreationTokens: 1112,
    tokensByModel: [
      {
        model: "gpt-5-codex",
        sourceVendor: "codex" as const,
        totalTokens: 33000,
        inputTokens: 15000,
        outputTokens: 12000,
        cacheReadTokens: 4000,
        cacheCreationTokens: 2000,
        costUsd: 12.34,
        avgOutputTokensPerSecond: 35.2,
        avgFirstTokenLatencyMs: 1200
      }
    ],
    totalToolCalls: 12,
    successfulExecutions: 10,
    failedExecutions: 2,
    startedOnlyExecutions: 0,
    successRate: 0.8333,
    editOperationCount: 4,
    affectedFileCount: 7,
    insertions: 42,
    deletions: 8,
    sourceBreakdown: [
      {
        sourceVendor: "claude-code" as const,
        sessionCount: 3,
        turnCount: 24,
        totalTokens: 45678,
        toolCalls: 12,
        costUsd: 12.34
      }
    ],
    providerBreakdown: [],
    totalCostUsd: 12.34
  };
}

function buildZeroOverview() {
  return {
    ...buildReadyOverview(),
    sessionCount: 0,
    turnCount: 0,
    responseCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokensByModel: [],
    totalToolCalls: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    successRate: 0,
    editOperationCount: 0,
    affectedFileCount: 0,
    insertions: 0,
    deletions: 0,
    sourceBreakdown: [],
    providerBreakdown: [],
    totalCostUsd: 0
  };
}

async function expectAxeClean(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa"]
    }
  });

  const seriousViolations = results.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious"
  );
  expect(seriousViolations).toEqual([]);
}

function readSourceChips(): { primary: string[]; others: string[] } {
  const toolbar = screen.getByRole("toolbar", { name: "Dashboard source filter" });
  const primary = Array.from(toolbar.children).map((child) => {
    if (child.classList.contains("dashboard-source-others")) {
      return "Others";
    }
    return readChipLabel(child);
  });
  const menu = within(toolbar).getByRole("group", { name: "Other sources" });
  const others = within(menu)
    .getAllByRole("button")
    .map((button) => readChipLabel(button));
  return { primary, others };
}

/** Source chips append their cost in a span; ordering assertions read the label only. */
function readChipLabel(button: Element): string {
  return Array.from(button.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function collectTabStops(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

function extractDashboardPageStyles(stylesheet: string): string {
  const start = stylesheet.indexOf(".dashboard-page");
  if (start < 0) {
    return "";
  }

  const mediaStart = stylesheet.indexOf("@media", start);
  return mediaStart < 0 ? stylesheet.slice(start) : stylesheet.slice(start, mediaStart);
}
