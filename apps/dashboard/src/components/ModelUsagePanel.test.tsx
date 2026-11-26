import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  it("sorts models by total tokens and groups them under the agent that ran them", () => {
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

    expect(rows).toHaveLength(6);
    // Groups appear in the rank order of their strongest model, and rows keep the
    // token ordering inside a group.
    expect(rows[0]).toHaveTextContent("gpt-5-codex");
    expect(rows[1]).toHaveTextContent("o3");
    expect(rows[2]).toHaveTextContent("claude-sonnet");
    expect(rows[3]).toHaveTextContent("haiku");
    expect(rows[4]).toHaveTextContent("Unknown model");
    expect(rows[5]).toHaveTextContent("gpt-4.1-mini");

    const groups = readGroups(container);
    expect(groups).toHaveLength(4);
    expect(screen.getByText("4 agents")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Codex models" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Claude Code models" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Cursor models" })).toBeInTheDocument();
  });

  it("groups Antigravity planner and worker models under the Antigravity agent", () => {
    const { container } = render(
      <ModelUsagePanel
        rows={[
          modelRow({
            model: "gemini-pro-orchestrator-neon",
            sourceVendor: "antigravity",
            totalTokens: 900,
            inputTokens: 500,
            outputTokens: 200,
            cacheReadTokens: 150,
            cacheCreationTokens: 50
          }),
          modelRow({
            model: "gemini-flash-worker-agy",
            sourceVendor: "antigravity",
            totalTokens: 400,
            inputTokens: 300,
            outputTokens: 100
          })
        ]}
      />
    );

    const groups = readGroups(container);

    expect(screen.getByText("1 agent")).toBeInTheDocument();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveTextContent("Antigravity");
    expect(groups[0]).toHaveTextContent("2 models · 1,300 tokens");
    expect(screen.getByRole("list", { name: "Antigravity models" })).toBeInTheDocument();
    expect(readRows(container)[0]).toHaveTextContent("gemini-pro-orchestrator-neon");
    expect(readRows(container)[1]).toHaveTextContent("gemini-flash-worker-agy");
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

  it("counts every model of an agent into the group header", () => {
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
          // Smallest model, but still part of the agent's rate.
          codexRow("f", 50, 0, 900)
        ]}
      />
    );

    expect(readRows(container)).toHaveLength(6);
    expect(screen.getByText("f")).toBeInTheDocument();

    const [group] = readGroups(container);
    expect(group).toHaveTextContent("6 models · 1,550 tokens");
    // 1,000 cache reads over 1,500 cacheable input across all six models.
    expect(group).toHaveTextContent("hit 66.7%");
    expect(screen.getByText("1 agent")).toBeInTheDocument();
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
            usageMode: "fast",
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
    expect(within(rows[1]).queryByText("gpt-6.1-sol (Fast)")).not.toBeInTheDocument();
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
    expect(within(rows[2]).getByTitle("No reference estimate is available. Reference estimates use published model and speed rates; subscription credits, long-context and regional modifiers are excluded.")).toBeInTheDocument();
    // Timing row: speed and TTFT render for rows with data, em-dash otherwise.
    expect(rows[0]).toHaveTextContent("42.4 tok/s");
    expect(rows[0]).toHaveTextContent("TTFT ≤ 830ms");
    expect(rows[2]).toHaveTextContent("— tok/s");
    expect(rows[2]).toHaveTextContent("TTFT —");
  });

  it("distinguishes usage modes on their own rows and keeps the tail agents reachable", () => {
    const rows = [
      modelRow({ model: "gpt-5-codex", sourceVendor: "codex", usageMode: "standard", totalTokens: 510 }),
      modelRow({ model: "gpt-5-codex", sourceVendor: "codex", usageMode: "fast", totalTokens: 3 }),
      modelRow({ model: "gpt-5-codex", sourceVendor: "codex", usageMode: "unknown", totalTokens: 4 }),
      modelRow({ model: "gpt-5-codex", sourceVendor: "codex", usageMode: "ultrafast", totalTokens: 2 }),
      modelRow({ model: "claude-sonnet", sourceVendor: "claude-code", usageMode: "fast", totalTokens: 2 }),
      modelRow({ model: "o3-fast", sourceVendor: "codex", usageMode: "fast", totalTokens: 1 }),
      modelRow({ model: "legacy-codex-fast", sourceVendor: "codex", totalTokens: 20 }),
      modelRow({ model: "kimi-k2-highspeed", sourceVendor: "kimicode", usageMode: "fast", totalTokens: 1 }),
      modelRow({ model: "mimo-v2-ultraspeed", sourceVendor: "mimo", usageMode: "fast", totalTokens: 1 }),
      modelRow({ model: "legacy-model", sourceVendor: "cursor", totalTokens: 240 }),
      modelRow({ model: "haiku", sourceVendor: "claude-code", usageMode: "standard", totalTokens: 110 }),
      modelRow({ model: "o3", sourceVendor: "codex", usageMode: "standard", totalTokens: 305 }),
      modelRow({ model: "gpt-4.1-mini", sourceVendor: "opencode", usageMode: "standard", totalTokens: 85 })
    ];

    const { container } = render(<ModelUsagePanel rows={rows} />);

    // Six agents, so the last one lives on the second page instead of being cut.
    expect(screen.getByText("6 agents · page 1/2")).toBeInTheDocument();
    expect(screen.getByText("Agents 1–5 of 6")).toBeInTheDocument();
    expect(screen.queryByText("mimo-v2-ultraspeed")).not.toBeInTheDocument();

    const list = screen.getByRole("list", { name: "Model usage rankings" });

    const fastCodex = getModelUsageItem(list, "gpt-5-codex (Fast)");
    const unknownCodex = getModelUsageItem(list, "gpt-5-codex (mode unknown)");
    const ultrafastCodex = getModelUsageItem(list, "gpt-5-codex (Ultrafast)");
    const fastClaude = getModelUsageItem(list, "claude-sonnet (Fast)");
    const fastWithSuffix = getModelUsageItem(list, "o3-fast");
    const fastLegacyRow = getModelUsageItem(list, "legacy-codex-fast");
    const kimiHighspeed = getModelUsageItem(list, "kimi-k2-highspeed");
    const standardCodex = getModelUsageItem(list, "gpt-5-codex");
    const legacyStandard = getModelUsageItem(list, "legacy-model");

    expect(within(fastCodex).getByText("3 tokens")).toBeInTheDocument();
    expect(within(unknownCodex).getByText("4 tokens")).toBeInTheDocument();
    expect(within(ultrafastCodex).getByText("2 tokens")).toBeInTheDocument();
    expect(within(standardCodex).getByText("510 tokens")).toBeInTheDocument();
    expect(within(getSourceGroup(fastClaude)).getByText("Claude Code")).toBeInTheDocument();
    expect(within(fastWithSuffix).getByText("o3-fast", { exact: true })).toBeInTheDocument();
    expect(within(fastLegacyRow).queryByText("legacy-codex-fast (mode unknown)")).not.toBeInTheDocument();
    expect(within(getSourceGroup(kimiHighspeed)).getByText("Kimi Code")).toBeInTheDocument();
    expect(within(legacyStandard).getByText("legacy-model", { exact: true })).toBeInTheDocument();
    expect(within(legacyStandard).queryByText("legacy-model (mode unknown)")).not.toBeInTheDocument();
    expect(within(list).getByText("gpt-4.1-mini")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));

    const pageTwo = screen.getByRole("list", { name: "Model usage rankings" });
    const mimoUltraspeed = getModelUsageItem(pageTwo, "mimo-v2-ultraspeed");

    expect(screen.getByText("6 agents · page 2/2")).toBeInTheDocument();
    expect(screen.getByText("Agent 6 of 6")).toBeInTheDocument();
    expect(within(getSourceGroup(mimoUltraspeed)).getByText("MiMo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next agents" })).toBeDisabled();
    expect(readRows(container)).toHaveLength(1);
  });

  it("pages agents five at a time and clamps the page when the scope shrinks", () => {
    const agentRow = (sourceVendor: TokensByModelRow["sourceVendor"], totalTokens: number) =>
      modelRow({ model: `${sourceVendor}-model`, sourceVendor, totalTokens });

    const { container, rerender } = render(
      <ModelUsagePanel
        rows={[
          agentRow("cursor", 700),
          agentRow("codex", 600),
          agentRow("claude-code", 500),
          agentRow("opencode", 400),
          agentRow("workbuddy", 300),
          agentRow("kimicode", 200),
          agentRow("mimo", 100)
        ]}
      />
    );

    expect(readGroups(container)).toHaveLength(5);
    expect(screen.getByText("7 agents · page 1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous agents" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next agents" }));
    expect(readGroups(container)).toHaveLength(2);
    expect(screen.getByText("Agents 6–7 of 7")).toBeInTheDocument();

    // A narrower scope hides the pager and falls back to the first page.
    rerender(<ModelUsagePanel rows={[agentRow("cursor", 700), agentRow("codex", 600)]} />);
    expect(readGroups(container)).toHaveLength(2);
    expect(screen.getByText("2 agents")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next agents" })).not.toBeInTheDocument();
  });

  it("labels source, cost estimate, token detail, speed, and TTFT", () => {
    render(
      <ModelUsagePanel
        rows={[
          modelRow({
            model: "gpt-5-codex",
            sourceVendor: "codex",
            usageMode: "standard",
            totalTokens: 510,
            inputTokens: 240,
            outputTokens: 180,
            cacheReadTokens: 60,
            cacheCreationTokens: 30,
            costUsd: 0.42,
            avgOutputTokensPerSecond: 42.4,
            avgFirstTokenLatencyMs: 830,
            speedSampleCount: 1,
            ttftSampleCount: 1
          }),
          modelRow({
            model: "gpt-6.1-sol",
            sourceVendor: "codex",
            usageMode: "unknown",
            totalTokens: 2_000_000,
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            costUsd: 12
          }),
          modelRow({
            model: "claude-sonnet-4-6",
            sourceVendor: "claude-code",
            usageMode: "fast",
            totalTokens: 410,
            costUsd: 0.0012,
            avgOutputTokensPerSecond: 50,
            avgFirstTokenLatencyMs: 700,
            speedSampleCount: 3,
            ttftSampleCount: 2
          }),
          modelRow({
            model: "mystery-model",
            sourceVendor: "cursor",
            usageMode: "unknown",
            totalTokens: 240,
            costUsd: null
          }),
          modelRow({
            model: "big-pickle",
            sourceVendor: "opencode",
            usageMode: "standard",
            totalTokens: 100,
            costUsd: 0
          }),
          modelRow({
            model: "deepseek-v4.1-flash",
            sourceVendor: "workbuddy",
            usageMode: "standard",
            totalTokens: 1_320,
            inputTokens: 1_000,
            outputTokens: 320,
            costUsd: 0.0007,
            avgOutputTokensPerSecond: 118.4,
            speedSampleCount: 2
          })
        ]}
      />
    );

    // Five agents, so every model fits on the single page.
    expect(screen.getByText("5 agents")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Model usage rankings" });
    const codexRow = getModelUsageItem(list, "gpt-5-codex");
    const unknownPricedRow = getModelUsageItem(list, "gpt-6.1-sol (mode unknown)");
    const claudeRow = getModelUsageItem(list, "claude-sonnet-4-6 (Fast)");
    const cursorRow = getModelUsageItem(list, "mystery-model (mode unknown)");
    const opencodeRow = getModelUsageItem(list, "big-pickle");
    const workbuddyRow = getModelUsageItem(list, "deepseek-v4.1-flash");

    expect(within(getSourceGroup(codexRow)).getByText("Codex")).toBeInTheDocument();
    expect(within(codexRow).getByText("in 240")).toBeInTheDocument();
    expect(within(codexRow).getByText("out 180")).toBeInTheDocument();
    expect(within(codexRow).getByText("cache 90")).toBeInTheDocument();
    expect(within(codexRow).getByText("$0.42")).toHaveAttribute(
      "title",
      "Reference estimate at published model and speed rates; excludes subscription credits, long-context and regional modifiers."
    );
    expect(codexRow).toHaveTextContent("42.4 tok/s est. · 1 sample");
    expect(codexRow).toHaveTextContent("TTFT ≤ 830ms · 1 sample");
    expect(within(codexRow).getByText(/tok\/s/)).toHaveAttribute(
      "title",
      "Estimated Codex output speed from usage-report intervals, excluding known tool overlaps. Request and network overhead may remain. Sample count is usage rows with a valid interval, not requests."
    );
    expect(within(codexRow).getByText(/TTFT/)).toHaveAttribute(
      "title",
      "For Codex, TTFT is an upper bound measured to the first usage report, not the exact first token time. Sample count is usage rows, not requests."
    );
    expect(within(unknownPricedRow).getByText("$12.00")).toHaveAttribute(
      "title",
      "Usage mode is unknown; this estimate uses the standard model reference rate because no speed-tier evidence is available. Fast/Ultrafast pricing is not inferred; subscription credits, long-context and regional modifiers are excluded."
    );
    expect(unknownPricedRow).toHaveTextContent("— tok/s est.");
    expect(unknownPricedRow).toHaveTextContent("TTFT —");
    expect(unknownPricedRow).not.toHaveTextContent("sample");
    expect(within(getSourceGroup(claudeRow)).getByText("Claude Code")).toBeInTheDocument();
    expect(within(claudeRow).getByText("$0.0012")).toBeInTheDocument();
    expect(claudeRow).toHaveTextContent("50.0 tok/s · 3 samples");
    expect(claudeRow).toHaveTextContent("TTFT 700ms · 2 samples");
    expect(claudeRow).not.toHaveTextContent("est.");
    expect(claudeRow).not.toHaveTextContent("≤");
    expect(
      within(cursorRow).getByTitle(
        "No reference estimate is available. Reference estimates use published model and speed rates; subscription credits, long-context and regional modifiers are excluded."
      )
    ).toHaveTextContent("—");
    expect(cursorRow).toHaveTextContent("— tok/s");
    expect(cursorRow).toHaveTextContent("TTFT —");
    expect(within(getSourceGroup(opencodeRow)).getByText("OpenCode")).toBeInTheDocument();
    expect(within(opencodeRow).getByText("$0.00")).toBeInTheDocument();
    // WorkBuddy speed may include derived windows and TTFT is absent for this sample.
    expect(within(getSourceGroup(workbuddyRow)).getByText("WorkBuddy")).toBeInTheDocument();
    expect(workbuddyRow).toHaveTextContent("118 tok/s est. · 2 samples");
    expect(workbuddyRow).toHaveTextContent("TTFT —");
    expect(within(workbuddyRow).getByText(/tok\/s/)).toHaveAttribute(
      "title",
      "WorkBuddy output speed uses matched provider timing when available, and otherwise a step wall-clock estimate that includes request overhead. The aggregate may combine both. Sample count is usage rows with a duration, not requests."
    );
  });

  it("shows matched WorkBuddy first-token latency when available", () => {
    const { container } = render(
      <ModelUsagePanel rows={[modelRow({
        model: "deepseek-v4.1-flash",
        sourceVendor: "workbuddy",
        totalTokens: 100,
        avgFirstTokenLatencyMs: 350,
        ttftSampleCount: 1
      })]} />
    );
    expect(readRows(container)[0]).toHaveTextContent("TTFT 350ms · 1 sample");
  });
});

function getModelUsageItem(list: HTMLElement, modelLabel: string): HTMLElement {
  const label = within(list).getByText(modelLabel, { exact: true });
  const item = label.closest<HTMLElement>(".model-usage-row");

  if (!item) {
    throw new Error(`Model usage row not found for: ${modelLabel}`);
  }

  return item;
}

function getSourceGroup(row: HTMLElement): HTMLElement {
  const group = row.closest<HTMLElement>(".model-usage-group");
  if (!group) throw new Error("Model usage group not found");
  return group;
}

function modelRow(
  overrides: Partial<TokensByModelRow> &
    Pick<TokensByModelRow, "model" | "sourceVendor" | "totalTokens">
): TokensByModelRow {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRate: 0,
    costUsd: null,
    avgOutputTokensPerSecond: null,
    avgFirstTokenLatencyMs: null,
    ...overrides
  };
}
