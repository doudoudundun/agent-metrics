import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { AgentMetricsDesktopBridge } from "../desktop-mode";
import { PeekCardDashboard } from "./PeekCardDashboard";

const apiMocks = vi.hoisted(() => ({
  fetchOverview: vi.fn(),
  fetchTools: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionDetail: vi.fn(),
  buildExportUrl: vi.fn()
}));

vi.mock("../api", () => ({
  ...apiMocks
}));

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  delete window.agentMetricsDesktop;
  apiMocks.fetchOverview.mockReset();
  apiMocks.fetchTools.mockReset();
  apiMocks.fetchSessions.mockReset();
  apiMocks.fetchSessionDetail.mockReset();
  apiMocks.buildExportUrl.mockReset();
  apiMocks.fetchOverview.mockResolvedValue({
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
  });
  apiMocks.fetchTools.mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: [
      { toolName: "Read", count: 0, failures: 0, averageDurationMs: 99 },
      { toolName: "Edit", count: 2, failures: 0, averageDurationMs: 15 }
    ]
  });
  apiMocks.fetchSessions.mockResolvedValue({
    mode: "calendar",
    range: "day",
    timezone: "Asia/Shanghai",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T16:00:00.000Z",
    updatedAt: "2026-05-27T10:30:00.000Z",
    rows: []
  });
  apiMocks.fetchSessionDetail.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

describe("PeekCardDashboard", () => {
  it("renders compact metrics without session copy", () => {
    render(
      <PeekCardDashboard
        status="ready"
        metrics={{
          totalTokens: 45678,
          totalToolCalls: 12,
          editOperationCount: 4,
          affectedFileCount: 7,
          insertions: 42,
          deletions: 8,
          successRate: 0.8333,
          failedExecutions: 2,
          averageDurationMs: 15
        }}
      />
    );

    expect(screen.getByText("Total Tokens")).toBeInTheDocument();
    expect(screen.getByText("45,678")).toBeInTheDocument();
    expect(screen.queryByText("Recent sessions")).not.toBeInTheDocument();
  });

  it("forwards pointer lifecycle events from the peek surface", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();

    render(
      <PeekCardDashboard
        status="ready"
        metrics={{
          totalTokens: 45678,
          totalToolCalls: 12,
          editOperationCount: 4,
          affectedFileCount: 7,
          insertions: 42,
          deletions: 8,
          successRate: 0.8333,
          failedExecutions: 2,
          averageDurationMs: 15
        }}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      />
    );

    const card = screen.getByLabelText("Desktop peek card");
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });

  it("desktop-orb-peek surface renders compact metrics, ignores zero-count tool rows, and skips sessions requests", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-orb-peek");
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

    render(<App />);

    expect(await screen.findByText("Total Tokens")).toBeInTheDocument();
    expect(screen.queryByText("Recent Sessions")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("15 ms")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    fireEvent.pointerEnter(screen.getByLabelText("Desktop peek card"));
    fireEvent.pointerLeave(screen.getByLabelText("Desktop peek card"));

    await waitFor(() => {
      expect(desktopBridge.pinPeekCard).toHaveBeenCalledTimes(1);
      expect(desktopBridge.expandOrbDetail).toHaveBeenCalledTimes(1);
      expect(desktopBridge.peekEnter).toHaveBeenCalledTimes(1);
      expect(desktopBridge.peekLeave).toHaveBeenCalledTimes(1);
      expect(desktopBridge.setOrbSnapshot).toHaveBeenCalled();
    });
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
  });

  it("keeps the last shared snapshot visible when compact refresh fails", async () => {
    window.history.replaceState({}, "", "/?surface=desktop-orb-peek");
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
      getOrbSnapshot: vi.fn().mockResolvedValue({
        status: "ready",
        updatedAt: "2026-05-27T10:30:00.000Z",
        metrics: {
          totalTokens: 9988,
          totalToolCalls: 7,
          editOperationCount: 2,
          affectedFileCount: 1,
          insertions: 18,
          deletions: 4,
          successRate: 0.5,
          failedExecutions: 3,
          averageDurationMs: 64
        }
      }),
      setOrbSnapshot: vi.fn().mockResolvedValue(undefined),
      markOrbStale: vi.fn().mockResolvedValue(undefined),
      peekEnter: vi.fn().mockResolvedValue(undefined),
      peekLeave: vi.fn().mockResolvedValue(undefined),
      orbDragStart: vi.fn().mockResolvedValue(undefined),
      orbDragMove: vi.fn().mockResolvedValue(undefined),
      orbDragEnd: vi.fn().mockResolvedValue(undefined)
    };
    window.agentMetricsDesktop = desktopBridge;
    apiMocks.fetchOverview.mockRejectedValue(new Error("Metrics core unavailable"));

    render(<App />);

    expect(await screen.findByText("9,988")).toBeInTheDocument();
    expect(await screen.findByText("Showing stale data")).toBeInTheDocument();
    await waitFor(() => {
      expect(desktopBridge.markOrbStale).toHaveBeenCalled();
    });
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
  });
});
