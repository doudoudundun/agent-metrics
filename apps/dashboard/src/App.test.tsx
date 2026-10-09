import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  fetchCursorAccountUsage,
  fetchOverview,
  fetchSessions,
  fetchSyncStatus,
  fetchTokenTrend,
  fetchTools
} from "./api";
import { fetchOverview as fetchLegacyOverview } from "./legacy-api";

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
  fetchCursorAccountUsage: vi.fn(),
  fetchSyncStatus: vi.fn(),
  fetchWidgetSnapshot: vi.fn(),
  fetchSessionDetail: vi.fn(),
  buildExportUrl: vi.fn(),
  triggerSync: vi.fn()
}));

vi.mock("./api", () => ({
  ...apiMocks
}));

vi.mock("./legacy-api", () => ({
  fetchOverview: apiMocks.fetchOverview,
  fetchTools: apiMocks.fetchTools,
  fetchTokenTrend: apiMocks.fetchTokenTrend,
  fetchSessions: apiMocks.fetchSessions,
  fetchSessionDetail: apiMocks.fetchSessionDetail,
  buildExportUrl: apiMocks.buildExportUrl
}));

describe("App surface router", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    delete window.agentMetricsDesktop;
    vi.mocked(fetchOverview).mockReset();
    vi.mocked(fetchTokenTrend).mockReset();
    vi.mocked(fetchTools).mockReset();
    vi.mocked(fetchSessions).mockReset();
    vi.mocked(fetchCursorAccountUsage).mockReset();
    vi.mocked(fetchSyncStatus).mockReset();
    apiMocks.fetchWidgetSnapshot.mockReset();
    apiMocks.fetchSessionDetail.mockReset();
    apiMocks.buildExportUrl.mockReset();
    seedMainDashboardMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders DashboardPage as the default browser surface", async () => {
    const view = render(<App />);

    expect(screen.getByRole("heading", { name: "Operational workspace" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Overview metrics for Today" })).toBeInTheDocument();
    expect(screen.queryByText("Modified files at a glance")).not.toBeInTheDocument();

    view.unmount();
  });

  it("renders DashboardPage for the desktop-main surface", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-main");

    const view = render(<App />);

    expect(screen.getByRole("heading", { name: "Operational workspace" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Overview metrics for Today" })).toBeInTheDocument();

    view.unmount();
  });

  it("renders the widget surface for desktop-widget", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-widget");

    const view = render(<App />);

    expect(await screen.findByText("Tools")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operational workspace" })).not.toBeInTheDocument();

    view.unmount();
  });

  it("renders the compact floating surface when the desktop floating query parameter is present", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-floating");

    const view = render(<App />);

    expect(await screen.findByRole("heading", { name: "Agent Metrics" })).toBeInTheDocument();
    expect(screen.getByText("Modified files at a glance")).toBeInTheDocument();
    expect(screen.queryByText("Export CSV")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Operational workspace" })).not.toBeInTheDocument();

    view.unmount();
  });

  it("shows a loading-specific floating state and skips full-dashboard background fetches", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-floating");
    vi.mocked(fetchLegacyOverview).mockImplementationOnce(() => new Promise(() => undefined));

    const view = render(<App />);

    expect(await screen.findByText("Loading live summary...")).toBeInTheDocument();
    expect(fetchTools).not.toHaveBeenCalled();
    expect(fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchSessionDetail).not.toHaveBeenCalled();

    view.unmount();
  });

  it("shows file-focused floating metrics without requesting sessions", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-floating");

    const view = render(<App />);

    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(await screen.findByText("45,678")).toBeInTheDocument();
    expect(screen.getByText("4 edits / +42 / -8")).toBeInTheDocument();
    expect(fetchSessions).not.toHaveBeenCalled();

    view.unmount();
  });
});

function seedMainDashboardMocks(): void {
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
    tokensByModel: [],
    totalToolCalls: 12,
    successfulExecutions: 10,
    failedExecutions: 2,
    startedOnlyExecutions: 0,
    successRate: 0.8333,
    editOperationCount: 4,
    affectedFileCount: 7,
    insertions: 42,
    deletions: 8,
    sourceBreakdown: [],
    providerBreakdown: [],
    totalCostUsd: 0
  });
  vi.mocked(fetchTokenTrend).mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: []
  });
  vi.mocked(fetchTools).mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: []
  });
  vi.mocked(fetchSessions).mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: [],
    nextCursor: null
  });
  vi.mocked(fetchCursorAccountUsage).mockResolvedValue(null);
  vi.mocked(fetchSyncStatus).mockResolvedValue({
    generatedAt: "2026-05-27T10:30:00.000Z",
    shuttingDown: false,
    adapters: []
  });
  apiMocks.fetchWidgetSnapshot.mockResolvedValue({
    generatedAt: new Date().toISOString(),
    scope: {
      mode: "calendar",
      range: "day",
      windowStart: "2026-07-16T16:00:00.000Z",
      windowEnd: "2026-07-17T10:00:00.000Z"
    },
    metrics: {
      totalTokens: 1234,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 100,
      cacheCreationTokens: 34,
      sessionCount: 2,
      logicalToolCalls: 3,
      cacheHitRate: 0.5,
      toolSuccessRate: 2 / 3,
      editOperationCount: 1,
      affectedFileCount: 2
    }
  });
  apiMocks.buildExportUrl.mockImplementation((format: "csv" | "json") => `/api/exports/${format}`);
}
