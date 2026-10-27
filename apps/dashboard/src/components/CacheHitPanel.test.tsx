import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceBreakdownRow } from "../api";
import { CacheHitPanel } from "./CacheHitPanel";

afterEach(() => {
  cleanup();
});

describe("CacheHitPanel", () => {
  it("ranks agents by cache hit rate and labels each row with the agent name", () => {
    render(
      <CacheHitPanel
        rows={[
          row("claude-code", 120000, 0.78),
          row("codex", 40000, 0.31),
          row("cursor", 9000, 0.05)
        ]}
      />
    );

    const items = readAgentRows();

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Claude Code");
    expect(items[0]).toHaveTextContent("120,000 tokens");
    expect(items[0]).toHaveTextContent("78%");
    expect(items[1]).toHaveTextContent("Codex");
    expect(items[1]).toHaveTextContent("31%");
    expect(items[2]).toHaveTextContent("Cursor");
    expect(items[2]).toHaveTextContent("5%");
    expect(readBarPercent(items[0])).toBeCloseTo(78);
    expect(readBarPercent(items[2])).toBeCloseTo(5);
  });

  it("breaks hit-rate ties by token volume", () => {
    render(<CacheHitPanel rows={[row("codex", 1000, 0.5), row("mimo", 50000, 0.5)]} />);

    const items = readAgentRows();

    expect(items[0]).toHaveTextContent("MiMo");
    expect(items[1]).toHaveTextContent("Codex");
  });

  it("leaves agents without usage in scope out of the ranking", () => {
    render(<CacheHitPanel rows={[row("claude-code", 0, 0), row("codex", 250, 0)]} />);

    const items = readAgentRows();

    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Codex");
    expect(items[0]).toHaveTextContent("0%");
    expect(screen.getByText("1 agent")).toBeInTheDocument();
  });

  it("shows the empty state when no agent has usage in scope", () => {
    render(<CacheHitPanel rows={[]} />);

    expect(screen.getByText("No cacheable input in this scope.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Cache hit rate by agent" })).not.toBeInTheDocument();
  });

  it("keeps the list to the top six agents and labels the cutoff", () => {
    render(
      <CacheHitPanel
        rows={[
          row("claude-code", 7000, 0.7),
          row("codex", 6000, 0.6),
          row("cursor", 5000, 0.5),
          row("mimo", 4000, 0.4),
          row("zcode", 3000, 0.3),
          row("dsh", 2000, 0.2),
          row("workbuddy", 1000, 0.1)
        ]}
      />
    );

    const items = readAgentRows();

    expect(items).toHaveLength(6);
    expect(items[5]).toHaveTextContent("DSH");
    expect(screen.queryByText("WorkBuddy")).not.toBeInTheDocument();
    expect(screen.getByText("Top 6 of 7")).toBeInTheDocument();
  });
});

function row(
  sourceVendor: SourceBreakdownRow["sourceVendor"],
  totalTokens: number,
  cacheHitRate: number
): SourceBreakdownRow {
  return { sourceVendor, sessionCount: 1, turnCount: 1, totalTokens, toolCalls: 1, costUsd: 0, cacheHitRate };
}

function readAgentRows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Cache hit rate by agent" })).getAllByRole("listitem");
}

function readBarPercent(item: HTMLElement): number {
  const bar = item.querySelector<HTMLElement>(".cache-hit-bar");
  expect(bar).not.toBeNull();

  return Number.parseFloat(bar?.style.width ?? "");
}
