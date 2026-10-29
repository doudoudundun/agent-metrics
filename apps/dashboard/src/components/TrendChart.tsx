import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { ToolRow } from "../api";
import type { TimeScopeSelection } from "../time-scope";
import { PanelScopeControls } from "./PanelScopeControls";

type TrendChartProps = {
  rows: ToolRow[];
  scope: TimeScopeSelection;
  scopeLabel: string;
  override: TimeScopeSelection | null;
  onOverrideChange: (next: TimeScopeSelection | null) => void;
  statusMessage?: string | null;
  emptyMessage?: string;
};

export function TrendChart({
  rows,
  scope,
  scopeLabel,
  override,
  onOverrideChange,
  statusMessage,
  emptyMessage
}: TrendChartProps) {
  const data = [...rows]
    .sort((left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName))
    .slice(0, 5)
    .map((row) => ({
      label: row.toolName,
      value: row.count
    }));
  const totalCalls = data.reduce((sum, row) => sum + row.value, 0);

  return (
    <section className="panel chart-panel">
      <div className="panel-heading panel-heading-scoped">
        <div className="panel-title-block">
          <h2>Activity Snapshot</h2>
          <PanelScopeControls
            panelName="Activity Snapshot"
            scope={scope}
            scopeLabel={scopeLabel}
            override={override}
            onOverrideChange={onOverrideChange}
          />
        </div>
        <div className="chart-summary">
          <span>Top 5 by calls</span>
          <strong>{totalCalls} calls total</strong>
        </div>
      </div>
      {statusMessage ? <p className="panel-scope-message">{statusMessage}</p> : null}
      {data.length > 0 ? (
        <div className="chart-frame">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} barCategoryGap={22}>
              <CartesianGrid stroke="rgba(32, 37, 31, 0.1)" strokeDasharray="2 5" vertical={false} />
              <XAxis dataKey="label" stroke="#6b7063" tickLine={false} axisLine={false} />
              <YAxis stroke="#6b7063" tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  background: "#20251f",
                  border: "1px solid #536143",
                  borderRadius: 10,
                  color: "#f8f7f2"
                }}
                formatter={(value: number) => [`${value} calls`, "Calls"]}
                cursor={{ fill: "rgba(32, 37, 31, 0.05)" }}
              />
              <Bar dataKey="value" fill="url(#activityBars)" radius={[5, 5, 0, 0]} isAnimationActive={false} />
              <defs>
                <linearGradient id="activityBars" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#d0f66b" />
                  <stop offset="100%" stopColor="#849471" />
                </linearGradient>
              </defs>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="panel-empty">{emptyMessage ?? "No tool activity in this scope."}</p>
      )}
    </section>
  );
}
