import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchOverview, fetchSessions, fetchTools } from "./api";
import type { AgentMetricsDesktopBridge } from "./desktop-mode";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const apiMocks = vi.hoisted(() => ({
  fetchOverview: vi.fn(),
  fetchTools: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionDetail: vi.fn(),
  buildExportUrl: vi.fn()
}));

vi.mock("./api", () => ({
  ...apiMocks
}));

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    delete window.agentMetricsDesktop;
    vi.mocked(fetchOverview).mockReset();
    vi.mocked(fetchTools).mockReset();
    vi.mocked(fetchSessions).mockReset();
    apiMocks.fetchSessionDetail.mockReset();
    apiMocks.buildExportUrl.mockReset();
    seedApiMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the selected scope label while overview data is loading", () => {
    vi.mocked(fetchOverview).mockImplementationOnce(() => new Promise(() => undefined));
    const view = render(<App />);

    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);

    view.unmount();
  });

  it("does not refetch when clicking the already selected scope", async () => {
    const view = render(<App />);

    expect(await screen.findByText("Total Tokens", {}, { timeout: 3000 })).toBeInTheDocument();
    await nextTick();
    vi.mocked(fetchOverview).mockClear();
    vi.mocked(fetchTools).mockClear();
    vi.mocked(fetchSessions).mockClear();

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "Today"
      })
    );
    await nextTick();

    expect(fetchOverview).not.toHaveBeenCalled();
    expect(fetchTools).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();

    view.unmount();
  }, 10000);

  it("keeps the existing dashboard visible while switching scope and refreshes scoped panels", async () => {
    const view = render(<App />);

    const overviewRegion = await screen.findByRole("region", {
      name: "Overview metrics for Today"
    });

    expect(within(overviewRegion).getByText("45,678")).toBeInTheDocument();
    vi.mocked(fetchOverview).mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(fetchTools).mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(fetchSessions).mockImplementationOnce(() => new Promise(() => undefined));

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "This Week"
      })
    );
    expect(screen.getAllByText("This Week").length).toBeGreaterThan(0);
    expect(screen.getAllByText("45,678").length).toBeGreaterThan(0);
    expect(screen.getByText("ses_1")).toBeInTheDocument();
    expect(screen.getAllByText("Refreshing global tool metrics...").length).toBeGreaterThan(0);
    expect(screen.getByText("Loading session activity...")).toBeInTheDocument();
    expect(
      screen.queryByText("Loading local activity signals from the metrics core.")
    ).not.toBeInTheDocument();

    view.unmount();
  });

  it("keeps stale overview data visible after switching scope when aggregate loading fails", async () => {
    const view = render(<App />);

    const overviewRegion = await screen.findByRole("region", {
      name: "Overview metrics for Today"
    });

    expect(within(overviewRegion).getByText("45,678")).toBeInTheDocument();
    vi.mocked(fetchOverview).mockRejectedValueOnce(new Error("Metrics core unavailable"));

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "This Week"
      })
    );

    expect(screen.getAllByText("This Week").length).toBeGreaterThan(0);
    expect(await screen.findByText("Showing stale local data")).toBeInTheDocument();
    expect(await screen.findByText("Metrics core unavailable")).toBeInTheDocument();
    expect(screen.getAllByText("45,678").length).toBeGreaterThan(0);
    expect(screen.queryByText("Failed to load dashboard metrics.")).not.toBeInTheDocument();

    view.unmount();
  });

  it("does not refetch session detail when switching scope with the same selected session", async () => {
    const view = render(<App />);

    expect(
      await screen.findByRole("region", {
        name: "Overview metrics for Today"
      })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.fetchSessionDetail).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "This Week"
      })
    );

    await nextTick();

    expect(apiMocks.fetchSessionDetail).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it("renders overview metrics, recent sessions, and a session timeline", async () => {
    const view = render(<App />);

    const overviewRegion = await screen.findByRole("region", {
      name: "Overview metrics for Today"
    });

    expect(overviewRegion).toBeInTheDocument();
    expect(within(overviewRegion).getByText("Total Tokens")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("Turns")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("45,678")).toBeInTheDocument();
    expect(
      within(overviewRegion).getByText("22,345 in / 19,876 out / 3,457 cache")
    ).toBeInTheDocument();
    expect(within(overviewRegion).getByText("24")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("12 responses")).toBeInTheDocument();
    expect(within(overviewRegion).getByText(/10 ok \/ 2 failed/)).toBeInTheDocument();
    expect(screen.queryByText("Estimated Tokens")).not.toBeInTheDocument();
    const modelUsagePanel = (await screen.findByRole("heading", { name: "Model Usage" })).closest(
      "section"
    );
    expect(modelUsagePanel).not.toBeNull();
    expect(within(modelUsagePanel!).getByText("gpt-5-codex")).toBeInTheDocument();
    expect(within(modelUsagePanel!).getByText("Unknown model")).toBeInTheDocument();

    const recentSessionsPanel = (
      await screen.findByRole("heading", { name: "Recent Sessions" })
    ).closest("section");
    expect(recentSessionsPanel).not.toBeNull();
    expect(within(recentSessionsPanel!).getByText("ses_1")).toBeInTheDocument();
    expect(within(recentSessionsPanel!).getByText("gpt-5-codex")).toBeInTheDocument();

    const timelinePanel = (await screen.findByRole("heading", { name: "Session Timeline" })).closest(
      "section"
    );
    expect(timelinePanel).not.toBeNull();
    expect(await within(timelinePanel!).findByText("174 total")).toBeInTheDocument();
    expect(within(timelinePanel!).getByText("Session")).toBeInTheDocument();
    expect(within(timelinePanel!).getByText("Assistant")).toBeInTheDocument();
    expect(within(timelinePanel!).getByText("Token")).toBeInTheDocument();
    expect(within(timelinePanel!).getAllByText("2026-05-25 08:00:01").length).toBeGreaterThan(0);
    expect(fetchOverview).toHaveBeenCalledWith({ mode: "calendar", range: "day" }, "all");
    expect(fetchTools).toHaveBeenCalledWith({ mode: "calendar", range: "day" }, "all");
    expect(fetchSessions).toHaveBeenCalledWith({ mode: "calendar", range: "day" }, "all");

    view.unmount();
  });

  it("filters dashboard requests by source without falling back to a full-page error state", async () => {
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
      successRate: 0,
      editOperationCount: 0,
      affectedFileCount: 0,
      insertions: 0,
      deletions: 0,
      sourceBreakdown:
        sourceVendor === "codex"
          ? [{ sourceVendor: "codex", sessionCount: 1, turnCount: 0, totalTokens: 150, toolCalls: 0 }]
          : [{ sourceVendor: "claude-code", sessionCount: 3, turnCount: 24, totalTokens: 45678, toolCalls: 12 }],
      providerBreakdown: []
    }));
    vi.mocked(fetchTools).mockImplementation(async (_, sourceVendor) => ({
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T16:00:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      rows: sourceVendor === "codex" ? [] : [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]
    }));
    vi.mocked(fetchSessions).mockImplementation(async (_, sourceVendor) => ({
      mode: "calendar",
      range: "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T16:00:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      rows:
        sourceVendor === "codex"
          ? [
              {
                sessionId: "ses_codex_1",
                workspacePath: "D:/projects/dev/agent-metrics",
                sourceVendor: "codex",
                sourceAdapter: "codex-rollout",
                providerId: "ai",
                providerHost: "api.psydo.top",
                turnCount: 0,
                totalTokens: 150,
                lastModel: "gpt-5-codex"
              }
            ]
          : [
              {
                sessionId: "ses_1",
                workspacePath: "D:/projects/dev/agent-metrics",
                sourceVendor: "claude-code",
                sourceAdapter: "claude-transcript",
                providerId: null,
                providerHost: null,
                turnCount: 14,
                totalTokens: 45678,
                lastModel: "gpt-5-codex"
              }
            ]
    }));

    const view = render(<App />);

    expect(await screen.findByRole("region", { name: "Overview metrics for Today" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    expect(await screen.findByText("150 tokens")).toBeInTheDocument();
    expect((await screen.findAllByText("Not available for this source yet.")).length).toBeGreaterThan(0);
    expect(fetchOverview).toHaveBeenLastCalledWith({ mode: "calendar", range: "day" }, "codex");
    expect(fetchTools).toHaveBeenLastCalledWith({ mode: "calendar", range: "day" }, "codex");
    expect(fetchSessions).toHaveBeenLastCalledWith({ mode: "calendar", range: "day" }, "codex");
    expect(screen.queryByText("Failed to load dashboard metrics.")).not.toBeInTheDocument();

    view.unmount();
  });

  it("keeps stale source data visible while loading a different source filter", async () => {
    const pendingCursorRequest = new Promise<never>(() => undefined);

    vi.mocked(fetchOverview).mockImplementation(async (_, sourceVendor) => {
      if (sourceVendor === "cursor") {
        return pendingCursorRequest;
      }

      return {
        mode: "calendar",
        range: "day",
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
        tokensByModel: [],
        totalToolCalls: 12,
        successfulExecutions: 10,
        failedExecutions: 2,
        successRate: 0.8333,
        editOperationCount: 4,
        affectedFileCount: 7,
        insertions: 42,
        deletions: 8,
        sourceBreakdown: [],
        providerBreakdown: []
      };
    });
    vi.mocked(fetchTools).mockImplementation(async (_, sourceVendor) => {
      if (sourceVendor === "cursor") {
        return pendingCursorRequest;
      }

      return {
        mode: "calendar",
        range: "day",
        timezone: "Asia/Shanghai",
        windowStart: "2026-05-26T16:00:00.000Z",
        windowEnd: "2026-05-27T16:00:00.000Z",
        updatedAt: "2026-05-27T10:30:00.000Z",
        rows: [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]
      };
    });
    vi.mocked(fetchSessions).mockImplementation(async (_, sourceVendor) => {
      if (sourceVendor === "cursor") {
        return pendingCursorRequest;
      }

      return {
        mode: "calendar",
        range: "day",
        timezone: "Asia/Shanghai",
        windowStart: "2026-05-26T16:00:00.000Z",
        windowEnd: "2026-05-27T16:00:00.000Z",
        updatedAt: "2026-05-27T10:30:00.000Z",
        rows: [
          {
            sessionId: "ses_1",
            workspacePath: "D:/projects/dev/agent-metrics",
            sourceVendor: "claude-code",
            sourceAdapter: "claude-transcript",
            providerId: null,
            providerHost: null,
            turnCount: 14,
            totalTokens: 45678,
            lastModel: "gpt-5-codex"
          }
        ]
      };
    });

    const view = render(<App />);

    expect(await screen.findByRole("region", { name: "Overview metrics for Today" })).toBeInTheDocument();
    expect(screen.getAllByText("45,678").length).toBeGreaterThan(0);
    expect(screen.getByText("ses_1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cursor" }));

    expect(screen.getAllByText("45,678").length).toBeGreaterThan(0);
    expect(screen.getByText("ses_1")).toBeInTheDocument();
    expect(screen.getAllByText("Cursor").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("Loading local activity signals from the metrics core.")
    ).not.toBeInTheDocument();

    view.unmount();
  });

  it("renders overview metrics before tools and sessions finish loading", async () => {
    vi.mocked(fetchTools).mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(fetchSessions).mockImplementationOnce(() => new Promise(() => undefined));

    const view = render(<App />);

    const overviewRegion = await screen.findByRole("region", { name: "Overview metrics for Today" });

    expect(overviewRegion).toBeInTheDocument();
    expect(within(overviewRegion).getByText("Tool Calls")).toBeInTheDocument();
    expect(screen.getAllByText("Loading global tool metrics...")).toHaveLength(2);
    expect(screen.getByText("Loading recent sessions...")).toBeInTheDocument();
    expect(screen.getByText("Waiting for session activity...")).toBeInTheDocument();

    view.unmount();
  });

  it("renders Updated using the overview timezone instead of the browser timezone", async () => {
    const updatedAt = "2026-05-27T01:30:00.000Z";
    const serverTimezone = pickNonLocalTimezone(updatedAt);
    const expectedUpdated = formatInTimeZone(updatedAt, serverTimezone);

    vi.mocked(fetchOverview).mockResolvedValue({
      mode: "calendar",
      range: "day",
      timezone: serverTimezone,
      windowStart: "2026-05-26T00:00:00.000Z",
      windowEnd: "2026-05-27T00:00:00.000Z",
      updatedAt,
      sessionCount: 3,
      turnCount: 24,
      responseCount: 12,
      totalTokens: 45678,
      inputTokens: 22345,
      outputTokens: 19876,
      cacheReadTokens: 2345,
      cacheCreationTokens: 1112,
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8,
      sourceBreakdown: [],
      providerBreakdown: []
    });

    const view = render(<App />);

    expect(await screen.findByText(expectedUpdated)).toBeInTheDocument();

    view.unmount();
  });

  it("renders export links", async () => {
    const view = render(<App />);

    expect(await screen.findByRole("link", { name: "Export CSV" })).toHaveAttribute(
      "href",
      "/api/exports/csv"
    );
    expect(await screen.findByRole("link", { name: "Export JSON" })).toHaveAttribute(
      "href",
      "/api/exports/json"
    );

    view.unmount();
  });

  it("renders the compact floating surface when the desktop floating query parameter is present", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-floating");

    const view = render(<App />);

    expect(await screen.findByRole("heading", { name: "Agent Metrics" })).toBeInTheDocument();
    expect(screen.getByText("Modified files at a glance")).toBeInTheDocument();
    expect(screen.queryByText("Export CSV")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent Sessions" })).not.toBeInTheDocument();
    expect(screen.queryByText("Recent sessions")).not.toBeInTheDocument();

    view.unmount();
  });

  it("shows a loading-specific floating state and skips full-dashboard background fetches", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-floating");
    vi.mocked(fetchOverview).mockImplementationOnce(() => new Promise(() => undefined));

    const view = render(<App />);

    expect(await screen.findByText("Loading live summary...")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Floating summary metrics" })).not.toBeInTheDocument();
    expect(fetchTools).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchSessionDetail).not.toHaveBeenCalled();
    expect(apiMocks.buildExportUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Export CSV" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent Sessions" })).not.toBeInTheDocument();

    view.unmount();
  });

  it("shows a failure-specific floating state when overview loading fails", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-floating");
    vi.mocked(fetchOverview).mockRejectedValueOnce(new Error("Metrics core unavailable"));

    const view = render(<App />);

    expect(await screen.findByText("Floating summary unavailable")).toBeInTheDocument();
    expect(screen.getByText("Metrics core unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Floating summary metrics" })).not.toBeInTheDocument();
    expect(fetchTools).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchSessionDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Export CSV" })).not.toBeInTheDocument();

    view.unmount();
  });

  it("shows file-focused floating metrics without requesting sessions", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-floating");

    const view = render(<App />);

    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(await screen.findByText("45,678")).toBeInTheDocument();
    expect(screen.getByText("4 edits / +42 / -8")).toBeInTheDocument();
    expect(screen.queryByText("Recent sessions")).not.toBeInTheDocument();
    expect(fetchTools).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchSessionDetail).not.toHaveBeenCalled();

    view.unmount();
  });

  it("preserves the full dashboard layout for the desktop main surface", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-main");

    const view = render(<App />);

    expect(
      await screen.findByRole("region", { name: "Overview metrics for Today" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export CSV" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent Sessions" })).toBeInTheDocument();
    expect(screen.queryByText("Always-on-top summary")).not.toBeInTheDocument();

    view.unmount();
  });

  it("shows desktop actions only when the preload bridge is available", async () => {
    const desktopBridge: AgentMetricsDesktopBridge = {
      getRuntimeStatus: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      showMainWindow: vi.fn(),
      toggleFloatingWindow: vi.fn().mockResolvedValue({ visible: true }),
      showOrb: vi.fn().mockResolvedValue(undefined),
      hideOrb: vi.fn().mockResolvedValue(undefined),
      pinPeekCard: vi.fn().mockResolvedValue(undefined),
      expandOrbDetail: vi.fn().mockResolvedValue(undefined),
      getOrbSnapshot: vi.fn().mockResolvedValue(null),
      setOrbSnapshot: vi.fn().mockResolvedValue(undefined),
      markOrbStale: vi.fn().mockResolvedValue(undefined),
      peekEnter: vi.fn().mockResolvedValue(undefined),
      peekLeave: vi.fn().mockResolvedValue(undefined),
      orbDragStart: vi.fn().mockResolvedValue(undefined),
      orbDragMove: vi.fn().mockResolvedValue(undefined),
      orbDragEnd: vi.fn().mockResolvedValue(undefined)
    };
    window.agentMetricsDesktop = desktopBridge;

    const view = render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Toggle Floating Window" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Toggle Floating Window" }));
    await waitFor(() => {
      expect(window.agentMetricsDesktop?.toggleFloatingWindow).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText("Runtime: desktop bridge ready")).toBeInTheDocument();
    });

    view.unmount();
  });

  it("hides desktop actions when the preload bridge contract is incomplete", async () => {
    window.agentMetricsDesktop = {
      getRuntimeStatus: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      showMainWindow: vi.fn(),
      toggleFloatingWindow: vi.fn().mockResolvedValue({ visible: true })
    } as AgentMetricsDesktopBridge;

    const view = render(<App />);

    await screen.findByRole("region", { name: "Overview metrics for Today" });
    expect(screen.queryByRole("button", { name: "Toggle Floating Window" })).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime: desktop bridge ready")).not.toBeInTheDocument();

    view.unmount();
  });

  it("shows All Time in the panel scope mode controls", async () => {
    const view = render(<App />);

    expect(
      await screen.findByRole("region", { name: "Overview metrics for Today" })
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Activity Snapshot mode")).getByRole("option", {
        name: "All Time"
      })
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Tool Rankings mode")).getByRole("option", {
        name: "All Time"
      })
    ).toBeInTheDocument();

    view.unmount();
  });

  it("lets the activity snapshot override the global scope without changing tool rankings", async () => {
    vi.mocked(fetchTools).mockImplementation(async (scope) => {
      const requestedScope = scope ?? { mode: "calendar", range: "day" };

      if (requestedScope.mode === "rolling" && requestedScope.range === "week") {
        return {
          mode: "rolling",
          range: "week",
          timezone: "Asia/Shanghai",
          windowStart: "2026-05-20T10:30:00.000Z",
          windowEnd: "2026-05-27T10:30:00.000Z",
          updatedAt: "2026-05-27T10:30:00.000Z",
          rows: [
            { toolName: "Read", count: 9, failures: 0, averageDurationMs: 15 },
            { toolName: "Edit", count: 4, failures: 0, averageDurationMs: 12 }
          ]
        };
      }

      return {
        mode: "calendar",
        range: "day",
        timezone: "Asia/Shanghai",
        windowStart: "2026-05-26T16:00:00.000Z",
        windowEnd: "2026-05-27T10:30:00.000Z",
        updatedAt: "2026-05-27T10:30:00.000Z",
        rows: [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]
      };
    });

    const view = render(<App />);

    expect(await screen.findByText("6 calls total")).toBeInTheDocument();
    vi.mocked(fetchOverview).mockClear();
    vi.mocked(fetchTools).mockClear();
    vi.mocked(fetchSessions).mockClear();

    fireEvent.change(await screen.findByLabelText("Activity Snapshot mode"), {
      target: { value: "rolling" }
    });
    fireEvent.change(screen.getByLabelText("Activity Snapshot range"), {
      target: { value: "week" }
    });

    expect(await screen.findByText("13 calls total")).toBeInTheDocument();
    expect(screen.getByText("1 tracked")).toBeInTheDocument();
    expect(fetchTools).toHaveBeenCalledWith({ mode: "rolling", range: "week" }, "all");
    expect(fetchOverview).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();

    view.unmount();
  });

  it("inherits the current global range when enabling an activity snapshot override", async () => {
    vi.mocked(fetchOverview).mockImplementation(async (scope) => ({
      mode: scope?.mode ?? "calendar",
      range: scope?.range ?? "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      sessionCount: 3,
      turnCount: 24,
      responseCount: 12,
      totalTokens: 45678,
      inputTokens: 22345,
      outputTokens: 19876,
      cacheReadTokens: 2345,
      cacheCreationTokens: 1112,
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8,
      sourceBreakdown: [],
      providerBreakdown: []
    }));
    vi.mocked(fetchTools).mockImplementation(async (scope) => ({
      mode: scope?.mode ?? "calendar",
      range: scope?.range ?? "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      rows: [{ toolName: "Read", count: scope?.range === "week" ? 8 : 6, failures: 0, averageDurationMs: 15 }]
    }));

    const view = render(<App />);

    expect(await screen.findByRole("region", { name: "Overview metrics for Today" })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "This Week"
      })
    );
    expect(await screen.findByRole("region", { name: "Overview metrics for This Week" })).toBeInTheDocument();
    vi.mocked(fetchTools).mockClear();

    fireEvent.change(await screen.findByLabelText("Activity Snapshot mode"), {
      target: { value: "rolling" }
    });

    await waitFor(() => {
      expect(fetchTools).toHaveBeenCalledWith({ mode: "rolling", range: "week" }, "all");
    });

    view.unmount();
  });

  it("keeps global activity snapshot data visible when the first override fetch fails", async () => {
    vi.mocked(fetchOverview).mockImplementation(async (scope) => ({
      mode: scope?.mode ?? "calendar",
      range: scope?.range ?? "day",
      timezone: "Asia/Shanghai",
      windowStart: "2026-05-26T16:00:00.000Z",
      windowEnd: "2026-05-27T10:30:00.000Z",
      updatedAt: "2026-05-27T10:30:00.000Z",
      sessionCount: 3,
      turnCount: 24,
      responseCount: 12,
      totalTokens: 45678,
      inputTokens: 22345,
      outputTokens: 19876,
      cacheReadTokens: 2345,
      cacheCreationTokens: 1112,
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8,
      sourceBreakdown: [],
      providerBreakdown: []
    }));
    vi.mocked(fetchTools).mockImplementation(async (scope) => {
      if (scope?.mode === "rolling" && scope.range === "week") {
        throw new Error("Tool scope unavailable");
      }

      return {
        mode: scope?.mode ?? "calendar",
        range: scope?.range ?? "day",
        timezone: "Asia/Shanghai",
        windowStart: "2026-05-26T16:00:00.000Z",
        windowEnd: "2026-05-27T10:30:00.000Z",
        updatedAt: "2026-05-27T10:30:00.000Z",
        rows: [{ toolName: "Read", count: scope?.range === "week" ? 8 : 6, failures: 0, averageDurationMs: 15 }]
      };
    });

    const view = render(<App />);

    expect(await screen.findByText("6 calls total")).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "This Week"
      })
    );
    expect(await screen.findByText("8 calls total")).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Activity Snapshot mode"), {
      target: { value: "rolling" }
    });

    expect(await screen.findByText("Activity Snapshot override failed: Tool scope unavailable")).toBeInTheDocument();
    expect(screen.getByText("8 calls total")).toBeInTheDocument();
    expect(screen.queryByText("0 calls total")).not.toBeInTheDocument();

    view.unmount();
  });

  it("lets tool rankings override the global scope without changing the activity snapshot", async () => {
    vi.mocked(fetchTools).mockImplementation(async (scope) => {
      if (scope?.mode === "rolling" && scope.range === "month") {
        return {
          mode: "rolling",
          range: "month",
          timezone: "Asia/Shanghai",
          windowStart: "2026-04-27T10:30:00.000Z",
          windowEnd: "2026-05-27T10:30:00.000Z",
          updatedAt: "2026-05-27T10:30:00.000Z",
          rows: [
            { toolName: "Read", count: 9, failures: 0, averageDurationMs: 15 },
            { toolName: "Edit", count: 4, failures: 0, averageDurationMs: 12 }
          ]
        };
      }

      return {
        mode: "calendar",
        range: "day",
        timezone: "Asia/Shanghai",
        windowStart: "2026-05-26T16:00:00.000Z",
        windowEnd: "2026-05-27T10:30:00.000Z",
        updatedAt: "2026-05-27T10:30:00.000Z",
        rows: [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]
      };
    });

    const view = render(<App />);

    expect(await screen.findByText("6 calls total")).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Tool Rankings mode"), {
      target: { value: "rolling" }
    });
    fireEvent.change(screen.getByLabelText("Tool Rankings range"), {
      target: { value: "month" }
    });

    expect(await screen.findByText("2 tracked")).toBeInTheDocument();
    expect(screen.getByText("6 calls total")).toBeInTheDocument();

    view.unmount();
  });
});

function seedApiMocks(): void {
  vi.mocked(fetchOverview).mockResolvedValue({
    mode: "calendar",
    range: "day",
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
        totalTokens: 33000,
        inputTokens: 15000,
        outputTokens: 12000,
        cacheReadTokens: 4000,
        cacheCreationTokens: 2000
      },
      {
        model: "unknown",
        totalTokens: 12678,
        inputTokens: 7345,
        outputTokens: 7876,
        cacheReadTokens: 345,
        cacheCreationTokens: 112
      }
    ],
    totalToolCalls: 12,
    successfulExecutions: 10,
    failedExecutions: 2,
    successRate: 0.8333,
    editOperationCount: 4,
    affectedFileCount: 7,
    insertions: 42,
    deletions: 8,
    sourceBreakdown: [
      {
        sourceVendor: "claude-code",
        sessionCount: 3,
        turnCount: 24,
        totalTokens: 45678,
        toolCalls: 12
      }
    ],
    providerBreakdown: []
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
        workspacePath: "D:/projects/dev/agent-metrics",
        sourceVendor: "claude-code",
        sourceAdapter: "claude-transcript",
        providerId: null,
        providerHost: null,
        turnCount: 14,
        totalTokens: 45678,
        lastModel: "gpt-5-codex"
      }
    ]
  });
  apiMocks.fetchSessionDetail.mockResolvedValue({
    sessionId: "ses_1",
    workspacePath: "D:/projects/dev/agent-metrics",
    sourceVendor: "claude-code",
    sourceAdapter: "claude-transcript",
    context: {
      executionPath: "D:/projects/dev/agent-metrics/.claude/tmp",
      skillsLoaded: true,
      skillNames: ["commit-analyzer"]
    },
    timeline: [
      {
        createdAt: "2026-05-25T08:00:00.000Z",
        type: "session.started",
        toolName: "",
        status: "started",
        durationMs: 0,
        sourceVendor: "claude-code",
        sourceAdapter: "claude-hook",
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
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
      },
      {
        createdAt: "2026-05-25T08:00:00.500Z",
        type: "prompt.submitted",
        toolName: "",
        status: "submitted",
        durationMs: 0,
        sourceVendor: "claude-code",
        sourceAdapter: "claude-transcript",
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        promptId: "prompt_1",
        promptChars: 19,
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
      },
      {
        createdAt: "2026-05-25T08:00:01.000Z",
        type: "tool.succeeded",
        toolName: "Read",
        status: "succeeded",
        durationMs: 12,
        sourceVendor: "claude-code",
        sourceAdapter: "claude-hook",
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
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
      },
      {
        createdAt: "2026-05-25T08:00:01.500Z",
        type: "assistant.responded",
        toolName: "",
        status: "responded",
        durationMs: 0,
        sourceVendor: "claude-code",
        sourceAdapter: "claude-transcript",
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        promptId: null,
        promptChars: null,
        messageId: "msg_1",
        model: "gpt-5-codex",
        stopReason: "end_turn",
        responseChars: 42,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        totalTokens: null,
        usageSource: null
      },
      {
        createdAt: "2026-05-25T08:00:01.750Z",
        type: "token.usage.recorded",
        toolName: "",
        status: "recorded",
        durationMs: 0,
        sourceVendor: "claude-code",
        sourceAdapter: "claude-transcript",
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0,
        promptId: null,
        promptChars: null,
        messageId: "msg_1",
        model: "unknown",
        stopReason: null,
        responseChars: null,
        inputTokens: 120,
        outputTokens: 34,
        cacheReadTokens: 8,
        cacheCreationTokens: 12,
        totalTokens: 174,
        usageSource: "claude-transcript"
      }
    ]
  });
  apiMocks.buildExportUrl.mockImplementation(
    (format: "csv" | "json") => `/api/exports/${format}`
  );
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function pickNonLocalTimezone(value: string): string {
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localFormatted = formatInTimeZone(value, localTimezone);
  const candidates = ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Pacific/Auckland"];

  for (const candidate of candidates) {
    if (formatInTimeZone(value, candidate) !== localFormatted) {
      return candidate;
    }
  }

  throw new Error("Expected to find a server timezone that differs from the local browser time.");
}

function formatInTimeZone(value: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(new Date(value));

  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")} ${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}`;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((entry) => entry.type === type)?.value;

  if (!value) {
    throw new Error(`Missing ${type} in formatted date parts.`);
  }

  return value;
}
