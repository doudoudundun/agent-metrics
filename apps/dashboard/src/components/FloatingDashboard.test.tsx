import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OverviewResponse, SessionRow } from "../api";
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
  successRate: 0.8333,
  editOperationCount: 4,
  affectedFileCount: 7,
  insertions: 42,
  deletions: 8,
  sourceBreakdown: [],
  providerBreakdown: []
};

const sessions: SessionRow[] = [
  {
    sessionId: "ses_1",
    workspacePath: "/workspace/alpha",
    sourceVendor: "claude-code",
    sourceAdapter: "claude-transcript",
    providerId: null,
    providerHost: null,
    turnCount: 14,
    totalTokens: 12000,
    lastModel: "gpt-5-codex"
  },
  {
    sessionId: "ses_2",
    workspacePath: "/workspace/beta",
    sourceVendor: "codex",
    sourceAdapter: "codex-rollout",
    providerId: "openai",
    providerHost: "api.openai.com",
    turnCount: 8,
    totalTokens: 9000,
    lastModel: "gpt-5-mini"
  }
];

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
  it("renders a compact summary with top sessions", () => {
    render(<FloatingDashboard overview={overview} sessions={sessions} status="ready" />);

    expect(screen.getByRole("heading", { name: "Agent Metrics" })).toBeInTheDocument();
    expect(screen.getByText("Always-on-top summary")).toBeInTheDocument();

    const kpis = screen.getByRole("list", { name: "Floating summary metrics" });
    expect(within(kpis).getByText("Sessions")).toBeInTheDocument();
    expect(within(kpis).getByText("6")).toBeInTheDocument();
    expect(within(kpis).getByText("42")).toBeInTheDocument();
    expect(within(kpis).getByText("45,678")).toBeInTheDocument();

    const sessionList = screen.getByRole("list", { name: "Recent sessions" });
    expect(within(sessionList).getByText("/workspace/alpha")).toBeInTheDocument();
    expect(within(sessionList).getByText("/workspace/beta")).toBeInTheDocument();
  });

  it("shows a loading state instead of healthy zero metrics while overview data is pending", () => {
    render(<FloatingDashboard overview={null} sessions={[]} status="loading" />);

    expect(screen.getByText("Loading live summary...")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Floating summary metrics" })).not.toBeInTheDocument();
  });

  it("shows an error state instead of healthy zero metrics when overview loading fails", () => {
    render(
      <FloatingDashboard
        overview={null}
        sessions={[]}
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
        sessions={sessions}
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
