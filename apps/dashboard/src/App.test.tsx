import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("./api", () => ({
  fetchOverview: async () => ({
    sessionCount: 3,
    totalToolCalls: 12,
    successfulExecutions: 10,
    failedExecutions: 2,
    successRate: 0.8333,
    editOperationCount: 4,
    affectedFileCount: 7,
    insertions: 42,
    deletions: 8
  }),
  fetchTools: async () => [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }],
  fetchSessions: async () => [{ sessionId: "ses_1", workspacePath: "D:/projects/dev/agent-metrics" }],
  fetchSessionDetail: async () => ({
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
  }),
  buildExportUrl: (format: "csv" | "json") => `/api/exports/${format}`
}));

describe("App", () => {
  it("renders overview metrics, recent sessions, and a session timeline", async () => {
    const view = render(<App />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(await screen.findByText("Affected Files")).toBeInTheDocument();
    expect(await screen.findByText("Insertions")).toBeInTheDocument();
    expect(await screen.findByText("Deletions")).toBeInTheDocument();
    expect(screen.queryByText("Estimated Tokens")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Recent Sessions" })).toBeInTheDocument();
    expect(await screen.findByText("ses_1")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Session Timeline" })).toBeInTheDocument();
    expect(await screen.findByText("session.started")).toBeInTheDocument();

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
});
