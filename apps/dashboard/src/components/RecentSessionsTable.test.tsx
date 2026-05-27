import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentSessionsTable } from "./RecentSessionsTable";

describe("RecentSessionsTable", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders turns, tokens, and model columns for recent sessions", () => {
    const onSelect = vi.fn();

    render(
      <RecentSessionsTable
        onSelect={onSelect}
        rows={[
          {
            sessionId: "ses_1",
            workspacePath: "D:/projects/dev/agent-metrics",
            turnCount: 14,
            totalTokens: 45678,
            lastModel: "gpt-5-codex"
          }
        ]}
        selectedSessionId={null}
      />
    );

    expect(screen.getByRole("columnheader", { name: "Turns" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Tokens" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("45,678")).toBeInTheDocument();
    expect(screen.getByText("gpt-5-codex")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "ses_1" }));

    expect(onSelect).toHaveBeenCalledWith("ses_1");
  });

  it("renders unknown when the session has no reported model", () => {
    render(
      <RecentSessionsTable
        onSelect={vi.fn()}
        rows={[
          {
            sessionId: "ses_2",
            workspacePath: "D:/projects/dev/agent-metrics",
            turnCount: 3,
            totalTokens: 210,
            lastModel: null
          }
        ]}
        selectedSessionId={null}
      />
    );

    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
});
