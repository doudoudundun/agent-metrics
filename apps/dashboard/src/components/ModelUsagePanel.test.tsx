import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelUsagePanel } from "./ModelUsagePanel";

afterEach(() => {
  cleanup();
});

describe("ModelUsagePanel", () => {
  it("sorts models by total tokens, limits the view to the top five, and renders an unknown fallback", () => {
    render(
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
            costUsd: 0.1
          },
          {
            model: "unknown",
            sourceVendor: "cursor",
            totalTokens: 240,
            inputTokens: 120,
            outputTokens: 80,
            cacheReadTokens: 25,
            cacheCreationTokens: 15,
            costUsd: null
          },
          {
            model: "claude-sonnet",
            sourceVendor: "claude-code",
            totalTokens: 410,
            inputTokens: 200,
            outputTokens: 140,
            cacheReadTokens: 50,
            cacheCreationTokens: 20,
            costUsd: 0.0012
          },
          {
            model: "gpt-5-codex",
            sourceVendor: "codex",
            totalTokens: 510,
            inputTokens: 240,
            outputTokens: 180,
            cacheReadTokens: 60,
            cacheCreationTokens: 30,
            costUsd: 0.42
          },
          {
            model: "haiku",
            sourceVendor: "claude-code",
            totalTokens: 110,
            inputTokens: 70,
            outputTokens: 25,
            cacheReadTokens: 10,
            cacheCreationTokens: 5,
            costUsd: 0
          },
          {
            model: "o3",
            sourceVendor: "codex",
            totalTokens: 305,
            inputTokens: 160,
            outputTokens: 100,
            cacheReadTokens: 25,
            cacheCreationTokens: 20,
            costUsd: 1.5
          }
        ]}
      />
    );

    const items = within(screen.getByRole("list", { name: "Model usage rankings" })).getAllByRole(
      "listitem"
    );

    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("gpt-5-codex");
    expect(items[1]).toHaveTextContent("claude-sonnet");
    expect(items[2]).toHaveTextContent("o3");
    expect(items[3]).toHaveTextContent("Unknown model");
    expect(items[4]).toHaveTextContent("haiku");
    expect(screen.queryByText("gpt-4.1-mini")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown model")).toBeInTheDocument();
  });

  it("labels each row with its source and estimated cost", () => {
    render(
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
            costUsd: 0.42
          },
          {
            model: "claude-sonnet-4-6",
            sourceVendor: "claude-code",
            totalTokens: 410,
            inputTokens: 200,
            outputTokens: 140,
            cacheReadTokens: 50,
            cacheCreationTokens: 20,
            costUsd: 0.0012
          },
          {
            model: "mystery-model",
            sourceVendor: "cursor",
            totalTokens: 240,
            inputTokens: 120,
            outputTokens: 80,
            cacheReadTokens: 25,
            cacheCreationTokens: 15,
            costUsd: null
          },
          {
            model: "big-pickle",
            sourceVendor: "opencode",
            totalTokens: 100,
            inputTokens: 60,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheCreationTokens: 10,
            costUsd: 0
          }
        ]}
      />
    );

    const items = within(screen.getByRole("list", { name: "Model usage rankings" })).getAllByRole(
      "listitem"
    );

    expect(within(items[0]).getByText("Codex")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("$0.42");
    expect(within(items[1]).getByText("Claude Code")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("$0.0012");
    expect(within(items[2]).getByText("Cursor")).toBeInTheDocument();
    expect(items[2]).toHaveTextContent("—");
    expect(within(items[3]).getByText("OpenCode")).toBeInTheDocument();
    expect(items[3]).toHaveTextContent("$0.00");
    expect(within(items[2]).getByTitle("No official pricing")).toBeInTheDocument();
  });
});
