import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToolRow } from "../api";
import { ToolRankingTable } from "./ToolRankingTable";

function renderPanel(rows: ToolRow[]) {
  return render(
    <ToolRankingTable
      rows={rows}
      scope={{ mode: "calendar", range: "day" }}
      scopeLabel="Today"
      override={null}
      onOverrideChange={vi.fn()}
    />
  );
}

function readTable(container: HTMLElement): string[][] {
  const body = container.querySelector("tbody");
  if (body === null) {
    return [];
  }

  return within(body)
    .getAllByRole("row")
    .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent ?? ""));
}

describe("ToolRankingTable", () => {
  it("shows when the panel is following the global scope", () => {
    renderPanel([{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]);

    expect(screen.getByText("Following global: Today")).toBeInTheDocument();
    expect(screen.getByText("1 tracked")).toBeInTheDocument();
  });

  it("orders tools by usage under the current scope", () => {
    const { container } = renderPanel([
      { toolName: "Grep", count: 2, failures: 0, averageDurationMs: 10 },
      { toolName: "Read", count: 9, failures: 1, averageDurationMs: 20 },
      { toolName: "Edit", count: 5, failures: 0, averageDurationMs: 30 }
    ]);

    expect(readTable(container).map((row) => row[0])).toEqual(["Read", "Edit", "Grep"]);
  });

  it("keeps every tool listed when the count stays within the limit", () => {
    const { container } = renderPanel([
      { toolName: "Read", count: 6, failures: 0, averageDurationMs: 10 },
      { toolName: "Edit", count: 5, failures: 1, averageDurationMs: 20 },
      { toolName: "Grep", count: 4, failures: 0, averageDurationMs: 30 },
      { toolName: "Bash", count: 3, failures: 0, averageDurationMs: 40 },
      { toolName: "Write", count: 2, failures: 0, averageDurationMs: 50 },
      { toolName: "Glob", count: 1, failures: 0, averageDurationMs: 60 }
    ]);

    expect(screen.getByText("6 tracked")).toBeInTheDocument();
    expect(readTable(container).map((row) => row[0])).toEqual([
      "Read",
      "Edit",
      "Grep",
      "Bash",
      "Write",
      "Glob"
    ]);
  });

  it("folds the least used tools into an Others row", () => {
    const { container } = renderPanel([
      { toolName: "Read", count: 10, failures: 0, averageDurationMs: 10 },
      { toolName: "Edit", count: 8, failures: 1, averageDurationMs: 20 },
      { toolName: "Grep", count: 6, failures: 0, averageDurationMs: 30 },
      { toolName: "Bash", count: 4, failures: 0, averageDurationMs: 40 },
      { toolName: "Write", count: 2, failures: 0, averageDurationMs: 50 },
      { toolName: "Glob", count: 1, failures: 1, averageDurationMs: 200 },
      { toolName: "TodoWrite", count: 1, failures: 0, averageDurationMs: 400 }
    ]);

    expect(screen.getByText("Top 5 of 7")).toBeInTheDocument();

    const rows = readTable(container);
    expect(rows.map((row) => row[0])).toEqual([
      "Read",
      "Edit",
      "Grep",
      "Bash",
      "Write",
      "Others (2)"
    ]);
    // calls/failures summed, duration weighted by call count: (200 + 400) / 2 = 300
    expect(rows[5]).toEqual(["Others (2)", "2", "1", "300 ms"]);
  });
});