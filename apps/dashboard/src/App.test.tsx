import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchOverview, fetchSessions, fetchTools } from "./api";

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

    expect(await screen.findByText("12")).toBeInTheDocument();
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
  });

  it("shows loading instead of old aggregate data after switching scope", async () => {
    const view = render(<App />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    vi.mocked(fetchOverview).mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(fetchTools).mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(fetchSessions).mockImplementationOnce(() => new Promise(() => undefined));

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "This Week"
      })
    );
    expect(
      await screen.findByText("Loading local activity signals from the metrics core.")
    ).toBeInTheDocument();
    expect(screen.queryByText("12")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Overview metrics for This Week" })
    ).not.toBeInTheDocument();

    view.unmount();
  });

  it("shows an explicit scoped failure after switching scope when aggregate loading fails", async () => {
    const view = render(<App />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    vi.mocked(fetchOverview).mockRejectedValueOnce(new Error("Metrics core unavailable"));

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dashboard time scope" })).getByRole("button", {
        name: "This Week"
      })
    );

    expect(await screen.findByText("Failed to load dashboard metrics.")).toBeInTheDocument();
    expect(await screen.findByText("Metrics core unavailable")).toBeInTheDocument();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getAllByText("This Week").length).toBeGreaterThan(0);
    expect(screen.queryByText("12")).not.toBeInTheDocument();

    view.unmount();
  });

  it("renders overview metrics, recent sessions, and a session timeline", async () => {
    const view = render(<App />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Overview metrics for Today" })
    ).toBeInTheDocument();
    expect(await screen.findByText("Affected Files")).toBeInTheDocument();
    expect(await screen.findByText("Insertions")).toBeInTheDocument();
    expect(await screen.findByText("Deletions")).toBeInTheDocument();
    expect(screen.queryByText("Estimated Tokens")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Recent Sessions" })).toBeInTheDocument();
    expect(await screen.findByText("ses_1")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Session Timeline" })).toBeInTheDocument();
    expect(await screen.findByText("session.started")).toBeInTheDocument();
    expect(await screen.findByText("2026-05-27 18:30:00")).toBeInTheDocument();
    expect(fetchOverview).toHaveBeenCalledWith({ mode: "calendar", range: "day" });
    expect(fetchTools).toHaveBeenCalledWith({ mode: "calendar", range: "day" });
    expect(fetchSessions).toHaveBeenCalledWith({ mode: "calendar", range: "day" });

    view.unmount();
  });

  it("renders overview metrics before tools and sessions finish loading", async () => {
    vi.mocked(fetchTools).mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(fetchSessions).mockImplementationOnce(() => new Promise(() => undefined));

    const view = render(<App />);

    expect(
      await screen.findByRole("region", { name: "Overview metrics for Today" })
    ).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
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
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8
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

  it("shows All Time in the panel scope mode controls", async () => {
    const view = render(<App />);

    expect(await screen.findByText("12")).toBeInTheDocument();
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
    expect(fetchTools).toHaveBeenCalledWith({ mode: "rolling", range: "week" });
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
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8
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
      expect(fetchTools).toHaveBeenCalledWith({ mode: "rolling", range: "week" });
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
      totalToolCalls: 12,
      successfulExecutions: 10,
      failedExecutions: 2,
      successRate: 0.8333,
      editOperationCount: 4,
      affectedFileCount: 7,
      insertions: 42,
      deletions: 8
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
    totalToolCalls: 12,
    successfulExecutions: 10,
    failedExecutions: 2,
    successRate: 0.8333,
    editOperationCount: 4,
    affectedFileCount: 7,
    insertions: 42,
    deletions: 8
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
    rows: [{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }]
  });
  apiMocks.fetchSessionDetail.mockResolvedValue({
    sessionId: "ses_1",
    timeline: [
      {
        type: "session.started",
        toolName: "",
        status: "started",
        durationMs: 0,
        filesChanged: [],
        insertions: 0,
        deletions: 0
      },
      {
        type: "tool.succeeded",
        toolName: "Read",
        status: "succeeded",
        durationMs: 12,
        filesChanged: [],
        insertions: 0,
        deletions: 0
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
