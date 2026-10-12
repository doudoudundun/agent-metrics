import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderBreakdownPanel } from "./ProviderBreakdownPanel";

afterEach(() => {
  cleanup();
});

describe("ProviderBreakdownPanel", () => {
  it("sorts providers by tokens, shows the host, and renders each share", () => {
    render(
      <ProviderBreakdownPanel
        rows={[
          { providerId: "openai", providerHost: null, totalTokens: 2000 },
          { providerId: "anthropic", providerHost: "api.anthropic.com", totalTokens: 6000 },
          { providerId: "deepseek", providerHost: "api.deepseek.com", totalTokens: 2000 }
        ]}
      />
    );

    const items = readProviderRows();

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("anthropic");
    expect(within(items[0]).getByText("api.anthropic.com")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("6,000 tokens");
    expect(items[0]).toHaveTextContent("60%");
    expect(items[1]).toHaveTextContent("deepseek");
    expect(items[1]).toHaveTextContent("2,000 tokens");
    expect(items[1]).toHaveTextContent("20%");
    expect(items[2]).toHaveTextContent("openai");
    expect(items[2].querySelector(".provider-breakdown-host")).toBeNull();
    expect(readBarPercent(items[0])).toBeCloseTo(60);
    expect(readBarPercent(items[1])).toBeCloseTo(20);
    expect(readBarPercent(items[2])).toBeCloseTo(20);
  });

  it("falls back to unknown for missing provider ids", () => {
    render(
      <ProviderBreakdownPanel
        rows={[
          { providerId: null, providerHost: null, totalTokens: 250 },
          { providerId: "unknown", providerHost: "gateway.internal", totalTokens: 750 },
          { providerId: "  ", providerHost: null, totalTokens: 500 }
        ]}
      />
    );

    const items = readProviderRows();

    expect(items).toHaveLength(3);
    expect(screen.getAllByText("unknown")).toHaveLength(3);
    expect(items[0]).toHaveTextContent("750 tokens");
    expect(items[0]).toHaveTextContent("50%");
    expect(within(items[0]).getByText("gateway.internal")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("500 tokens");
    expect(items[1]).toHaveTextContent("33.3%");
    expect(items[2]).toHaveTextContent("250 tokens");
    expect(items[2]).toHaveTextContent("16.7%");
  });

  it("shows a friendly empty state when there are no provider rows", () => {
    render(<ProviderBreakdownPanel rows={[]} />);

    expect(screen.getByText("No provider token usage in this scope.")).toBeInTheDocument();
    expect(screen.getByText("0 providers")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Provider token breakdown" })).not.toBeInTheDocument();
  });

  it("keeps the list to the top five providers and labels the cutoff", () => {
    render(
      <ProviderBreakdownPanel
        rows={[1, 2, 3, 4, 5, 6, 7].map((index) => ({
          providerId: `provider-${index}`,
          providerHost: null,
          totalTokens: (8 - index) * 1000
        }))}
      />
    );

    const items = readProviderRows();
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("provider-1");
    expect(items[4]).toHaveTextContent("provider-5");
    expect(screen.getByText("Top 5 of 7")).toBeInTheDocument();
  });
});

function readProviderRows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Provider token breakdown" })).getAllByRole("listitem");
}

function readBarPercent(item: HTMLElement): number {
  const bar = item.querySelector<HTMLElement>(".provider-breakdown-bar");
  expect(bar).not.toBeNull();

  return Number.parseFloat(bar?.style.width ?? "");
}
