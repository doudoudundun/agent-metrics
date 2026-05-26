import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrendChart } from "./TrendChart";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

describe("TrendChart", () => {
  it("shows the total calls across the top five tools", () => {
    render(
      <TrendChart
        rows={[
          { toolName: "Read", count: 9, failures: 0, averageDurationMs: 10 },
          { toolName: "Edit", count: 8, failures: 0, averageDurationMs: 11 },
          { toolName: "Bash", count: 7, failures: 1, averageDurationMs: 12 },
          { toolName: "Write", count: 6, failures: 0, averageDurationMs: 13 },
          { toolName: "Grep", count: 5, failures: 0, averageDurationMs: 14 },
          { toolName: "ReadManyFiles", count: 4, failures: 0, averageDurationMs: 15 }
        ]}
      />
    );

    expect(screen.getByText("Top 5 by calls")).toBeInTheDocument();
    expect(screen.getByText("35 calls total")).toBeInTheDocument();
  });
});
