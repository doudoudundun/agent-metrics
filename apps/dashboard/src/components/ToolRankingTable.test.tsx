import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolRankingTable } from "./ToolRankingTable";

describe("ToolRankingTable", () => {
  it("shows when the panel is following the global scope", () => {
    render(
      <ToolRankingTable
        rows={[{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]}
        scope={{ mode: "calendar", range: "day" }}
        scopeLabel="Today"
        override={null}
        onOverrideChange={vi.fn()}
      />
    );

    expect(screen.getByText("Following global: Today")).toBeInTheDocument();
    expect(screen.getByText("1 tracked")).toBeInTheDocument();
  });
});
