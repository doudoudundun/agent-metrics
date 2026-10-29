import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveDashboardStatus,
  formatDashboardStatusLabel
} from "./dashboard-status";
import { DashboardPage } from "./DashboardPage";
import {
  buildExportUrl,
  fetchCursorAccountUsage,
  fetchKeyUsage,
  fetchOverview,
  fetchSessionDetail,
  fetchSessions,
  fetchSyncStatus,
  fetchTokenTrend,
  fetchTools
} from "./api";

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
  fetchKeyUsage: vi.fn(),
  fetchSyncRun: vi.fn(),
  fetchSyncStatus: vi.fn(),
  triggerSync: vi.fn(),
  buildExportUrl: vi.fn()
}));

vi.mock("./api", () => ({
  ...apiMocks
}));

describe("DashboardPage visual and accessibility guard", () => {
  beforeEach(() => {
    seedContractApiMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render the legacy hero panel", async () => {
    render(<DashboardPage />);

    expect(await screen.findByRole("heading", { name: "Your agents, in focus." })).toBeInTheDocument();
    expect(document.querySelector(".hero-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("Local Ops Console")).not.toBeInTheDocument();
  });

  it("renders accessible status labels for health fixtures", () => {
    const fixtures = [
      { status: deriveDashboardStatus("loading", null, [], false), label: "Loading metrics" },
      { status: deriveDashboardStatus("ready", { sessionCount: 0, totalTokens: 0 }, [], false), label: "No activity in this scope" },
      { status: deriveDashboardStatus("ready", { sessionCount: 3, totalTokens: 100 }, [{ status: "syncing" }], false), label: "Live and up to date" },
      { status: deriveDashboardStatus("ready", { sessionCount: 3, totalTokens: 100 }, [{ status: "stale" }], false), label: "Live and up to date" },
      { status: deriveDashboardStatus("ready", { sessionCount: 3, totalTokens: 100 }, [], false), label: "Live and up to date" },
      { status: deriveDashboardStatus("ready", { sessionCount: 3, totalTokens: 100 }, [{ status: "error" }], false), label: "Showing stale data" },
      { status: deriveDashboardStatus("stale", { sessionCount: 3, totalTokens: 100 }, [], false), label: "Showing stale data" },
      { status: deriveDashboardStatus("error", null, [], false), label: "Metrics core offline" },
      { status: deriveDashboardStatus("error", { sessionCount: 3, totalTokens: 100 }, [], false), label: "Overview unavailable" }
    ] as const;

    for (const fixture of fixtures) {
      expect(formatDashboardStatusLabel(fixture.status)).toBe(fixture.label);
    }
  });

  it("keeps dashboard-page styles free of radial-gradient glow blobs", () => {
    const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "styles.css");
    const stylesheet = readFileSync(stylesPath, "utf8");
    const dashboardRules = extractDashboardPageRules(stylesheet);

    expect(dashboardRules.length).toBeGreaterThan(0);
    expect(dashboardRules).not.toMatch(/radial-gradient/i);
    expect(dashboardRules).not.toMatch(/bokeh/i);
  });
});

function extractDashboardPageRules(stylesheet: string): string {
  return stylesheet
    .split("\n")
    .filter((line) => /dashboard-|\.health-chip|\.overview-strip/.test(line))
    .join("\n");
}

function seedContractApiMocks(): void {
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
  vi.mocked(fetchKeyUsage).mockResolvedValue({ updatedAt: null, entries: [] });
  vi.mocked(fetchSessionDetail).mockResolvedValue(null as never);
  vi.mocked(fetchSyncStatus).mockResolvedValue({
    generatedAt: "2026-05-27T10:30:00.000Z",
    shuttingDown: false,
    adapters: []
  });
  vi.mocked(buildExportUrl).mockImplementation((format: "csv" | "json") => `/api/exports/${format}`);
}
