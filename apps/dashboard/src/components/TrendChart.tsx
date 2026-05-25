import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type TrendChartProps = {
  totalToolCalls: number;
  successfulExecutions: number;
  editOperationCount: number;
};

export function TrendChart({
  totalToolCalls,
  successfulExecutions,
  editOperationCount
}: TrendChartProps) {
  const data = [
    { label: "Calls", value: totalToolCalls },
    { label: "Success", value: successfulExecutions },
    { label: "Edits", value: editOperationCount }
  ];

  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <h2>Activity Snapshot</h2>
        <span>Refreshing every 5s</span>
      </div>
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
