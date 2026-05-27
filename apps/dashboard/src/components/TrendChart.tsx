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
};

export function TrendChart({
  rows,
  scope,
  scopeLabel,
  override,
  onOverrideChange,
  statusMessage
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
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data} barCategoryGap={28}>
            <CartesianGrid stroke="rgba(225, 232, 242, 0.12)" vertical={false} />
            <XAxis dataKey="label" stroke="#95a7c0" tickLine={false} axisLine={false} />
            <YAxis stroke="#95a7c0" tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                background: "#0f1f2f",
                border: "1px solid rgba(209, 255, 77, 0.25)",
                borderRadius: 14,
                color: "#edf4ff"
              }}
              formatter={(value: number) => [`${value} calls`, "Calls"]}
              cursor={{ fill: "rgba(209, 255, 77, 0.08)" }}
            />
            <Bar dataKey="value" fill="url(#activityBars)" radius={[12, 12, 0, 0]} />
            <defs>
              <linearGradient id="activityBars" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#d1ff4d" />
                <stop offset="100%" stopColor="#5cc7ff" />
              </linearGradient>
            </defs>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
