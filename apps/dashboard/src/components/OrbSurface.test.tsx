import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { AgentMetricsDesktopBridge } from "../desktop-mode";
import { OrbSurface } from "./OrbSurface";

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
    rows: [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]
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

describe("OrbSurface", () => {
  it("renders a clickable button for opening the desktop peek card", () => {
    render(<OrbSurface collapsed={false} stale={false} />);

    expect(
      screen.getByRole("button", { name: "Open desktop peek card" })
    ).toBeInTheDocument();
  });

  it("forwards pointer and click events", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    const onActivate = vi.fn();

    render(
      <OrbSurface
        collapsed={true}
        stale={true}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onActivate={onActivate}
      />
    );

    const button = screen.getByRole("button", { name: "Open desktop peek card" });
    fireEvent.pointerEnter(button);
    fireEvent.pointerDown(button, {
      button: 0,
      pointerId: 1,
      clientX: 18,
      clientY: 18
    });
    fireEvent.pointerUp(button, {
      button: 0,
      pointerId: 1,
      clientX: 18,
      clientY: 18
    });
    fireEvent.click(button);
    fireEvent.pointerLeave(button);

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("requests the orb context menu on right click and suppresses the default menu", () => {
    const onContextMenu = vi.fn();

    render(<OrbSurface collapsed={false} stale={false} onContextMenu={onContextMenu} />);

    const button = screen.getByRole("button", { name: "Open desktop peek card" });
    const prevented = !fireEvent.contextMenu(button);

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it("starts dragging without firing activate when the pointer moves", () => {
    const onActivate = vi.fn();
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();

    render(
      <OrbSurface
        collapsed={false}
        stale={false}
        onActivate={onActivate}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
    );

    const button = screen.getByRole("button", { name: "Open desktop peek card" });
    fireEvent.mouseDown(button, { button: 0, clientX: 20, clientY: 22 });
    fireEvent.mouseMove(button, { clientX: 32, clientY: 38 });
    fireEvent.mouseUp(button, { button: 0, clientX: 32, clientY: 38 });
    fireEvent.click(button);

    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("desktop-orb surface forwards bridge actions and skips tools and sessions requests", () => {
    window.history.replaceState({}, "", "/?surface=desktop-orb");
    const desktopBridge: AgentMetricsDesktopBridge = {
      getRuntimeStatus: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      showMainWindow: vi.fn(),
      toggleFloatingWindow: vi.fn().mockResolvedValue({ visible: true }),
      showOrb: vi.fn().mockResolvedValue(undefined),
      hideOrb: vi.fn().mockResolvedValue(undefined),
      pinPeekCard: vi.fn().mockResolvedValue({ pinned: true }),
      togglePeekCardPin: vi.fn().mockResolvedValue({ pinned: true }),
      expandOrbDetail: vi.fn().mockResolvedValue(undefined),
      getOrbSnapshot: vi.fn().mockResolvedValue(null),
      setOrbSnapshot: vi.fn().mockResolvedValue(undefined),
      markOrbStale: vi.fn().mockResolvedValue(undefined),
      peekEnter: vi.fn().mockResolvedValue(undefined),
      peekLeave: vi.fn().mockResolvedValue(undefined),
      orbDragStart: vi.fn().mockResolvedValue(undefined),
      orbDragMove: vi.fn().mockResolvedValue(undefined),
      orbDragEnd: vi.fn().mockResolvedValue(undefined),
      showOrbMenu: vi.fn().mockResolvedValue(undefined)
    };
    window.agentMetricsDesktop = desktopBridge;

    render(<App />);

    const button = screen.getByRole("button", { name: "Open desktop peek card" });
    fireEvent.pointerEnter(button);
    fireEvent.pointerDown(button, {
      button: 0,
      pointerId: 1,
      clientX: 16,
      clientY: 16
    });
    fireEvent.pointerUp(button, {
      button: 0,
      pointerId: 1,
      clientX: 16,
      clientY: 16
    });
    fireEvent.click(button);
    fireEvent.contextMenu(button);
    fireEvent.mouseDown(button, { button: 0, clientX: 12, clientY: 14 });
    fireEvent.mouseMove(button, { clientX: 22, clientY: 24 });
    fireEvent.mouseUp(button, { button: 0, clientX: 22, clientY: 24 });
    fireEvent.pointerLeave(button);

    expect(desktopBridge.showOrb).toHaveBeenCalledTimes(1);
    expect(desktopBridge.hideOrb).toHaveBeenCalledTimes(1);
    expect(desktopBridge.pinPeekCard).toHaveBeenCalledTimes(1);
    expect(desktopBridge.togglePeekCardPin).not.toHaveBeenCalled();
    expect(desktopBridge.showOrbMenu).toHaveBeenCalledTimes(1);
    expect(desktopBridge.orbDragStart).toHaveBeenCalledTimes(1);
    expect(desktopBridge.orbDragEnd).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchTools).not.toHaveBeenCalled();
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
  });
});
