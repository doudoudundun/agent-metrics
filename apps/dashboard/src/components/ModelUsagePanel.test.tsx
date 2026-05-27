import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelUsagePanel } from "./ModelUsagePanel";

describe("ModelUsagePanel", () => {
  it("sorts models by total tokens, limits the view to the top five, and renders an unknown fallback", () => {
    render(
      <ModelUsagePanel
        rows={[
          {
            model: "gpt-4.1-mini",
            totalTokens: 85,
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheCreationTokens: 5
          },
          {
            model: "unknown",
            totalTokens: 240,
            inputTokens: 120,
            outputTokens: 80,
            cacheReadTokens: 25,
            cacheCreationTokens: 15
          },
          {
            model: "claude-sonnet",
            totalTokens: 410,
            inputTokens: 200,
            outputTokens: 140,
            cacheReadTokens: 50,
            cacheCreationTokens: 20
          },
          {
            model: "gpt-5-codex",
            totalTokens: 510,
            inputTokens: 240,
            outputTokens: 180,
            cacheReadTokens: 60,
            cacheCreationTokens: 30
          },
          {
            model: "haiku",
            totalTokens: 110,
            inputTokens: 70,
            outputTokens: 25,
            cacheReadTokens: 10,
            cacheCreationTokens: 5
          },
          {
            model: "o3",
            totalTokens: 305,
            inputTokens: 160,
            outputTokens: 100,
            cacheReadTokens: 25,
            cacheCreationTokens: 20
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
});
