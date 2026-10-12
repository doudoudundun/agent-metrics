import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenTrendBucket } from "@agent-metrics/contracts";
import type { TokenTrendPoint } from "../api";
import { TokenTrendPanel } from "./TokenTrendPanel";

// Recharts needs real layout to draw axes, so the chart is stubbed with probes
// that render the props the panel feeds it as text.
vi.mock("recharts", async () => {
  const { createElement } = await import("react");
  const shell = (children?: ReactNode) => createElement("div", null, children);

  return {
    ResponsiveContainer: (props: { children?: ReactNode }) => shell(props.children),
    LineChart: (props: { children?: ReactNode }) => shell(props.children),
    CartesianGrid: () => null,
    YAxis: () => null,
    Line: () => null,
    XAxis: (props: { dataKey?: string; interval?: number }) =>
      shell(`x-axis:${props.dataKey}:${String(props.interval)}`),
    Tooltip: (props: { labelFormatter?: (label: unknown) => unknown }) =>
      shell(`tooltip:${String(props.labelFormatter?.("3/3-3/9") ?? "")}`)
  };
});

afterEach(() => {
  cleanup();
});

const BUCKET_PREFIX: Record<TokenTrendBucket, string> = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month"
};

function trendRows(bucket: TokenTrendBucket | undefined, count: number): TokenTrendPoint[] {
  return Array.from({ length: count }, (_, index): TokenTrendPoint => ({
    bucketStart: new Date(Date.UTC(2026, 2, 2 + index)).toISOString(),
    bucket,
    label: `bucket-${index}`,
    totalTokens: 100,
    inputTokens: 60,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheCreationTokens: 10,
    cacheHitRate: 0.1
  }));
}

function renderPanel(rows: TokenTrendPoint[]): void {
  render(
    <TokenTrendPanel
      rows={rows}
      scope={{ mode: "calendar", range: "day" }}
      scopeLabel="Today"
      override={null}
      onOverrideChange={vi.fn()}
    />
  );
}

describe("TokenTrendPanel", () => {
  it("plots the backend label on the x axis and reflects the backend granularity in the tooltip", () => {
    renderPanel(trendRows("day", 3));

    expect(screen.getByText("x-axis:label:undefined")).toBeInTheDocument();
    expect(screen.getByText("tooltip:Day 3/3-3/9")).toBeInTheDocument();
    expect(screen.getByText("Token Trend")).toBeInTheDocument();
    expect(screen.getByText("3 buckets visible")).toBeInTheDocument();
  });

  it("thins weekly and monthly tick labels while hourly and daily rows keep the default spacing", () => {
    const cases: Array<{ bucket: TokenTrendBucket; count: number; interval: string }> = [
      { bucket: "week", count: 5, interval: "0" },
      { bucket: "week", count: 20, interval: "2" },
      { bucket: "month", count: 24, interval: "2" },
      { bucket: "hour", count: 24, interval: "undefined" },
      { bucket: "day", count: 24, interval: "undefined" }
    ];

    for (const testCase of cases) {
      cleanup();
      renderPanel(trendRows(testCase.bucket, testCase.count));

      expect(screen.getByText(`x-axis:label:${testCase.interval}`)).toBeInTheDocument();
      expect(
        screen.getByText(`tooltip:${BUCKET_PREFIX[testCase.bucket]} 3/3-3/9`)
      ).toBeInTheDocument();
    }
  });

  it("keeps rows without a bucket on the legacy tooltip text and default spacing", () => {
    renderPanel(trendRows(undefined, 4));

    expect(screen.getByText("x-axis:label:undefined")).toBeInTheDocument();
    expect(screen.getByText("tooltip:Bucket 3/3-3/9")).toBeInTheDocument();
  });

  it("renders the empty state instead of a chart when there are no buckets", () => {
    renderPanel([]);

    expect(screen.queryByText(/^x-axis:/u)).not.toBeInTheDocument();
    expect(screen.getByText("No token activity in this scope.")).toBeInTheDocument();
  });
});