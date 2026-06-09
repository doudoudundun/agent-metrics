import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { TokenTrendPoint } from "../api";
import type { TimeScopeSelection } from "../time-scope";
import { PanelScopeControls } from "./PanelScopeControls";

type TokenTrendPanelProps = {
  rows: TokenTrendPoint[];
  scope: TimeScopeSelection;
  scopeLabel: string;
  override: TimeScopeSelection | null;
  onOverrideChange: (next: TimeScopeSelection | null) => void;
  statusMessage?: string | null;
  emptyMessage?: string;
};

const TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

export function TokenTrendPanel({
  rows,
  scope,
  scopeLabel,
  override,
  onOverrideChange,
  statusMessage,
  emptyMessage
}: TokenTrendPanelProps) {
  const totalTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCacheRead = rows.reduce((sum, row) => sum + row.cacheReadTokens, 0);
  const totalCacheableInput = rows.reduce(
    (sum, row) => sum + row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens,
    0
  );
  const cacheHitRate = totalCacheableInput > 0 ? totalCacheRead / totalCacheableInput : 0;

  return (
    <section className="panel chart-panel">
      <div className="panel-heading panel-heading-scoped">
        <div className="panel-title-block">
          <h2>Token Trend</h2>
          <PanelScopeControls
            panelName="Token Trend"
            scope={scope}
            scopeLabel={scopeLabel}
            override={override}
            onOverrideChange={onOverrideChange}
          />
        </div>
        <div className="chart-summary">
          <span>{rows.length} buckets visible</span>
          <strong>{totalTokens.toLocaleString()} total</strong>
          <span>{formatPercent(cacheHitRate)} cache hit</span>
        </div>
      </div>
      {statusMessage ? <p className="panel-scope-message">{statusMessage}</p> : null}
      {rows.length > 0 ? (
        <>
          <div className="token-trend-legend" aria-label="Token trend series">
            <span className="token-trend-legend__item">
              <i className="token-trend-legend__swatch" data-series="input" />
              Input
            </span>
            <span className="token-trend-legend__item">
              <i className="token-trend-legend__swatch" data-series="output" />
              Output
            </span>
            <span className="token-trend-legend__item">
              <i className="token-trend-legend__swatch" data-series="cache-read" />
              Cache Read
            </span>
            <span className="token-trend-legend__item">
              <i className="token-trend-legend__swatch" data-series="cache-write" />
              Cache Write
            </span>
            <span className="token-trend-legend__item">
              <i className="token-trend-legend__swatch" data-series="cache-hit" />
              Cache Hit
            </span>
          </div>
          <div className="chart-frame chart-frame--tall">
            <ResponsiveContainer width="100%" height={248}>
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(225, 232, 242, 0.12)" vertical={false} />
                <XAxis dataKey="label" stroke="#95a7c0" tickLine={false} axisLine={false} />
                <YAxis
                  yAxisId="tokens"
                  stroke="#95a7c0"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatCompactTokens}
                />
                <YAxis
                  yAxisId="rate"
                  orientation="right"
                  domain={[0, 1]}
                  stroke="#95a7c0"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatPercent}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0f1f2f",
                    border: "1px solid rgba(209, 255, 77, 0.25)",
                    borderRadius: 14,
                    color: "#edf4ff"
                  }}
                  formatter={(value: number, name: string) => {
                    if (name === "Cache Hit") {
                      return [formatPercent(value), name];
                    }

                    return [value.toLocaleString(), name];
                  }}
                  labelFormatter={(label) => `Bucket ${label}`}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="inputTokens"
                  name="Input"
                  stroke="#d1ff4d"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="outputTokens"
                  name="Output"
                  stroke="#5cc7ff"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheReadTokens"
                  name="Cache Read"
                  stroke="#7bf7d4"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheCreationTokens"
                  name="Cache Write"
                  stroke="#ffbd7a"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="cacheHitRate"
                  name="Cache Hit"
                  stroke="#f3f7ff"
                  strokeDasharray="5 4"
                  strokeWidth={1.75}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <p className="panel-empty">{emptyMessage ?? "No token activity in this scope."}</p>
      )}
    </section>
  );
}

function formatCompactTokens(value: number): string {
  return TOKEN_FORMATTER.format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
