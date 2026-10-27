import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TokensByModelRow } from "../api";
import { ModelUsagePanel } from "./ModelUsagePanel";

afterEach(() => {
  cleanup();
});

/** Model rows are grouped, so tests read the rows out of the DOM in render order. */
function readRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".model-usage-row")];
}

function readGroups(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".model-usage-group")];
}

describe("ModelUsagePanel", () => {
  it("sorts models by total tokens, limits the view to the top five, and groups them by agent", () => {
    const { container } = render(
      <ModelUsagePanel
        rows={[
          {
            model: "gpt-4.1-mini",
            sourceVendor: "opencode",
            totalTokens: 85,
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            cacheHitRate: 0.1538,
            costUsd: 0.1,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "unknown",
            sourceVendor: "cursor",
            totalTokens: 240,
            inputTokens: 120,
            outputTokens: 80,
            cacheReadTokens: 25,
            cacheCreationTokens: 15,
            cacheHitRate: 0.1563,
            costUsd: null,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "claude-sonnet",
            sourceVendor: "claude-code",
            totalTokens: 410,
            inputTokens: 200,
            outputTokens: 140,
            cacheReadTokens: 50,
            cacheCreationTokens: 20,
            cacheHitRate: 0.1852,
            costUsd: 0.0012,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "gpt-5-codex",
            sourceVendor: "codex",
            totalTokens: 510,
            inputTokens: 240,
            outputTokens: 180,
            cacheReadTokens: 60,
            cacheCreationTokens: 30,
            cacheHitRate: 0.1818,
            costUsd: 0.42,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "haiku",
            sourceVendor: "claude-code",
            totalTokens: 110,
            inputTokens: 70,
            outputTokens: 25,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            cacheHitRate: 0.1176,
            costUsd: 0,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "o3",
            sourceVendor: "codex",
            totalTokens: 305,
            inputTokens: 160,
            outputTokens: 100,
            cacheReadTokens: 25,
            cacheCreationTokens: 20,
            cacheHitRate: 0.122,
            costUsd: 1.5,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          }
        ]}
      />
    );

    const rows = readRows(container);

    expect(rows).toHaveLength(5);
    // Groups appear in the rank order of their strongest model, and rows keep the
    // token ordering inside a group.
    expect(rows[0]).toHaveTextContent("gpt-5-codex");
    expect(rows[1]).toHaveTextContent("o3");
    expect(rows[2]).toHaveTextContent("claude-sonnet");
    expect(rows[3]).toHaveTextContent("haiku");
    expect(rows[4]).toHaveTextContent("Unknown model");
    expect(screen.queryByText("gpt-4.1-mini")).not.toBeInTheDocument();

    const groups = readGroups(container);
    expect(groups).toHaveLength(3);
    expect(screen.getByRole("list", { name: "Codex models" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Claude Code models" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Cursor models" })).toBeInTheDocument();
  });

  it("shows the agent-wide cache hit rate on the group header", () => {
    const { container } = render(
      <ModelUsagePanel
        rows={[
          // codex: cacheable 240+60+30 + 160+25+20 = 535, read 85 -> 15.9%
          {
            model: "gpt-5-codex",
            sourceVendor: "codex",
            totalTokens: 510,
            inputTokens: 240,
            outputTokens: 180,
            cacheReadTokens: 60,
            cacheCreationTokens: 30,
            cacheHitRate: 0.1818,
            costUsd: 0.42,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "o3",
            sourceVendor: "codex",
            totalTokens: 305,
            inputTokens: 160,
            outputTokens: 100,
            cacheReadTokens: 25,
            cacheCreationTokens: 20,
            cacheHitRate: 0.122,
            costUsd: 1.5,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "claude-sonnet",
            sourceVendor: "claude-code",
            totalTokens: 410,
            inputTokens: 200,
            outputTokens: 140,
            cacheReadTokens: 50,
            cacheCreationTokens: 20,
            cacheHitRate: 0.1852,
            costUsd: 0.0012,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          }
        ]}
      />
    );

    const [codexGroup, claudeGroup] = readGroups(container);

    expect(codexGroup).toHaveTextContent("Codex");
    expect(codexGroup).toHaveTextContent("2 models · 815 tokens");
    expect(codexGroup).toHaveTextContent("hit 15.9%");
    // Per-model rates stay on their own row, so both levels are readable.
    expect(readRows(codexGroup)[0]).toHaveTextContent("hit 18.2%");
    expect(claudeGroup).toHaveTextContent("1 model ·");
    expect(claudeGroup).toHaveTextContent("hit 18.5%");
  });

  it("counts models outside the visible cut into the group header", () => {
    const codexRow = (
      model: string,
      totalTokens: number,
      inputTokens: number,
      cacheReadTokens: number
    ): TokensByModelRow => ({
      model,
      sourceVendor: "codex",
      totalTokens,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens,
      cacheCreationTokens: 0,
      cacheHitRate: inputTokens + cacheReadTokens > 0 ? cacheReadTokens / (inputTokens + cacheReadTokens) : 0,
      costUsd: null,
      avgOutputTokensPerSecond: null,
      avgFirstTokenLatencyMs: null
    });

    const { container } = render(
      <ModelUsagePanel
        rows={[
          codexRow("a", 500, 100, 100),
          codexRow("b", 400, 100, 0),
          codexRow("c", 300, 100, 0),
          codexRow("d", 200, 100, 0),
          codexRow("e", 100, 100, 0),
          // Pushed out of the top five, but still part of the agent's rate.
          codexRow("f", 50, 0, 900)
        ]}
      />
    );

    expect(readRows(container)).toHaveLength(5);
    expect(screen.queryByText("f")).not.toBeInTheDocument();

    const [group] = readGroups(container);
    expect(group).toHaveTextContent("6 models · 1,550 tokens");
    // 1,000 cache reads over 1,500 cacheable input across all six models.
    expect(group).toHaveTextContent("hit 66.7%");
    expect(screen.getByText("1 agent · top 5 of 6 models")).toBeInTheDocument();
  });

  it("renders an accelerated tier as its own row badged with its billing multiplier", () => {
    const { container } = render(
      <ModelUsagePanel
        rows={[
          {
            model: "gpt-6.1-sol",
            sourceVendor: "codex",
            serviceTier: null,
            serviceTierMultiplier: 1,
            totalTokens: 900,
            inputTokens: 600,
            outputTokens: 300,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheHitRate: 0,
            costUsd: 1.8,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "gpt-6.1-sol",
            sourceVendor: "codex",
            serviceTier: "fast",
            serviceTierMultiplier: 2,
            totalTokens: 400,
            inputTokens: 300,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cacheHitRate: 0,
            costUsd: 1.6,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          }
        ]}
      />
    );

    const rows = readRows(container);

    expect(rows).toHaveLength(2);
    // Standard traffic carries no badge; the fast row is a separate, badged line.
    expect(within(rows[0]).queryByText(/fast/i)).not.toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("fast 2x");
    expect(rows[1]).toHaveTextContent("$1.60");
    // No cacheable input in either row, so the rate reads 0 rather than blank.
    expect(rows[0]).toHaveTextContent("hit 0.0%");
    expect(rows[1]).toHaveTextContent("hit 0.0%");
    expect(readGroups(container)[0]).toHaveTextContent("hit 0.0%");
  });

  it("labels each group with its source and each row with its estimated cost", () => {
    const { container } = render(
      <ModelUsagePanel
        rows={[
          {
            model: "gpt-5-codex",
            sourceVendor: "codex",
            totalTokens: 510,
            inputTokens: 240,
            outputTokens: 180,
            cacheReadTokens: 60,
            cacheCreationTokens: 30,
            cacheHitRate: 0.1818,
            costUsd: 0.42,
            avgOutputTokensPerSecond: 42.4,
            avgFirstTokenLatencyMs: 830
          },
          {
            model: "claude-sonnet-4-6",
            sourceVendor: "claude-code",
            totalTokens: 410,
            inputTokens: 200,
            outputTokens: 140,
            cacheReadTokens: 50,
            cacheCreationTokens: 20,
            cacheHitRate: 0.1852,
            costUsd: 0.0012,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "mystery-model",
            sourceVendor: "cursor",
            totalTokens: 240,
            inputTokens: 120,
            outputTokens: 80,
            cacheReadTokens: 25,
            cacheCreationTokens: 15,
            cacheHitRate: 0.1563,
            costUsd: null,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          },
          {
            model: "big-pickle",
            sourceVendor: "opencode",
            totalTokens: 100,
            inputTokens: 60,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheCreationTokens: 10,
            cacheHitRate: 0.125,
            costUsd: 0,
            avgOutputTokensPerSecond: null,
            avgFirstTokenLatencyMs: null
          }
        ]}
      />
    );

    const rows = readRows(container);
    const groups = readGroups(container);

    expect(groups[0]).toHaveTextContent("Codex");
    expect(groups[1]).toHaveTextContent("Claude Code");
    expect(groups[2]).toHaveTextContent("Cursor");
    expect(groups[3]).toHaveTextContent("OpenCode");
    expect(rows[0]).toHaveTextContent("$0.42");
    expect(rows[1]).toHaveTextContent("$0.0012");
    expect(rows[2]).toHaveTextContent("—");
    expect(rows[3]).toHaveTextContent("$0.00");
    // Cache hit rate is rendered per model next to its token split.
    expect(rows[0]).toHaveTextContent("cache 90");
    expect(rows[0]).toHaveTextContent("hit 18.2%");
    expect(rows[1]).toHaveTextContent("hit 18.5%");
    expect(within(rows[2]).getByTitle("No official pricing")).toBeInTheDocument();
    // Timing row: speed and TTFT render for rows with data, em-dash otherwise.
    expect(rows[0]).toHaveTextContent("42.4 tok/s");
    expect(rows[0]).toHaveTextContent("TTFT 830ms");
    expect(rows[2]).toHaveTextContent("— tok/s");
    expect(rows[2]).toHaveTextContent("TTFT —");
  });
});
