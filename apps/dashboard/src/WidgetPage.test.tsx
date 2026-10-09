import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetPage } from "./WidgetPage";
import { fetchSyncStatus, fetchWidgetSnapshot } from "./api";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchSyncStatus: vi.fn(),
    fetchWidgetSnapshot: vi.fn(),
    triggerSync: vi.fn()
  };
});

const snapshot = {
  generatedAt: new Date().toISOString(),
  scope: {
    mode: "calendar" as const,
    range: "day" as const,
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
};

const syncStatus = {
  generatedAt: "2026-07-17T10:00:00.000Z",
  shuttingDown: false,
  adapters: []
};

describe("WidgetPage", () => {
  beforeEach(() => {
    vi.mocked(fetchWidgetSnapshot).mockResolvedValue(snapshot);
    vi.mocked(fetchSyncStatus).mockResolvedValue(syncStatus);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the primary metric and secondary metrics from the shared snapshot", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 384 });
    render(<WidgetPage />);

    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ready");
    // The header label must reflect the backend snapshot scope (calendar today).
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Today");
  });

  it("renders compact collapsed chrome at the native collapsed width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 88 });
    render(<WidgetPage />);

    expect(await screen.findByLabelText("Agent Metrics widget collapsed")).toBeInTheDocument();
    expect(screen.getByText("AM")).toBeInTheDocument();
    expect(screen.getByText("1.2K")).toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });

  it("releases keyboard focus after a footer button click so the widget can auto-collapse", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 384 });
    render(<WidgetPage />);
    await screen.findByText("1,234");

    const refresh = screen.getByRole("button", { name: "Refresh" });
    refresh.focus();
    expect(document.activeElement).toBe(refresh);

    fireEvent.click(refresh);
    // Spec §16.4: a button click must not leave keyboard focus on the button,
    // otherwise `keyboardFocusInside` stays true and blocks the collapse rule.
    expect(document.activeElement).not.toBe(refresh);
  });
});
