import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PeekCardDashboard } from "./PeekCardDashboard";

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
});
