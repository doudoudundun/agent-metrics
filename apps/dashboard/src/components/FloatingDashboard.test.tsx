import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OverviewResponse } from "../api";
import { resolveDesktopSurface } from "../desktop-mode";
import { FloatingDashboard } from "./FloatingDashboard";

afterEach(() => {
  cleanup();
});

const overview: OverviewResponse = {
  mode: "calendar",
  range: "day",
  timezone: "Asia/Shanghai",
  windowStart: "2026-05-26T16:00:00.000Z",
  windowEnd: "2026-05-27T16:00:00.000Z",
  updatedAt: "2026-05-27T10:30:00.000Z",
  sessionCount: 6,
  turnCount: 42,
  responseCount: 18,
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
  providerBreakdown: []
};

describe("resolveDesktopSurface", () => {
  it("falls back to the browser surface when no desktop query parameter is present", () => {
    expect(resolveDesktopSurface("")).toEqual({
      isDesktop: false,
      surface: "browser"
    });
  });

  it("maps the surface query parameter into floating mode", () => {
    expect(resolveDesktopSurface("?surface=desktop-floating")).toEqual({
      isDesktop: true,
      surface: "desktop-floating"
    });
  });
});

describe("FloatingDashboard", () => {
  it("renders a compact summary focused on files, tool calls, and tokens", () => {
    render(<FloatingDashboard overview={overview} status="ready" />);

    expect(screen.getByRole("heading", { name: "Agent Metrics" })).toBeInTheDocument();
    expect(screen.getByText("Modified files at a glance")).toBeInTheDocument();

    const kpis = screen.getByRole("list", { name: "Floating summary metrics" });
    expect(within(kpis).getByText("Modified Files")).toBeInTheDocument();
    expect(within(kpis).getByText("7")).toBeInTheDocument();
    expect(within(kpis).getByText("12")).toBeInTheDocument();
    expect(screen.getByText("10 ok / 2 failed")).toBeInTheDocument();
    expect(within(kpis).getByText("45,678")).toBeInTheDocument();
    expect(screen.getByText("4 edits / +42 / -8")).toBeInTheDocument();
    expect(screen.getByText("2,345 cache read")).toBeInTheDocument();
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent sessions")).not.toBeInTheDocument();
    expect(screen.queryByText(/success rate/i)).not.toBeInTheDocument();
  });

  it("falls back to closed tool calls when the backend total is still inflated", () => {
    render(
      <FloatingDashboard
        overview={{
          ...overview,
          totalToolCalls: 5323,
          successfulExecutions: 2576,
          failedExecutions: 20
        }}
        status="ready"
      />
    );

    const kpis = screen.getByRole("list", { name: "Floating summary metrics" });
    expect(within(kpis).getByText("2,596")).toBeInTheDocument();
    expect(screen.getByText("2,576 ok / 20 failed")).toBeInTheDocument();
    expect(screen.queryByText("5,323")).not.toBeInTheDocument();
  });

  it("shows a loading state instead of healthy zero metrics while overview data is pending", () => {
    render(<FloatingDashboard overview={null} status="loading" />);

    expect(screen.getByText("Loading live summary...")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Floating summary metrics" })).not.toBeInTheDocument();
  });

  it("shows an error state instead of healthy zero metrics when overview loading fails", () => {
    render(
      <FloatingDashboard
        overview={null}
        status="error"
        statusMessage="Metrics core unavailable"
      />
    );

    expect(screen.getByText("Floating summary unavailable")).toBeInTheDocument();
    expect(screen.getByText("Metrics core unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Floating summary metrics" })).not.toBeInTheDocument();
  });

  it("keeps rendered metrics visible while marking stale floating data", () => {
    render(
      <FloatingDashboard
        overview={overview}
        status="stale"
        statusMessage="Showing stale local data"
      />
    );

    expect(screen.getByText("Showing stale summary")).toBeInTheDocument();
    expect(screen.getByText("Showing stale local data")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Floating summary metrics" })).toBeInTheDocument();
    expect(screen.getByText("45,678")).toBeInTheDocument();
  });
});
