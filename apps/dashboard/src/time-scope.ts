export type TimeScopeMode = "calendar" | "rolling" | "lifetime";
export type TimeScopeRange = "day" | "week" | "month";

export type TimeScopeSelection = {
  mode: TimeScopeMode;
  range: TimeScopeRange;
};

export const DEFAULT_TIME_SCOPE: TimeScopeSelection = {
  mode: "calendar",
  range: "day"
};

const CALENDAR_LABELS: Record<TimeScopeRange, string> = {
  day: "Today",
  week: "This Week",
  month: "This Month"
};

const ROLLING_LABELS: Record<TimeScopeRange, string> = {
  day: "Last 24 Hours",
  week: "Last 7 Days",
  month: "Last 30 Days"
};

export function buildScopeLabel(selection: TimeScopeSelection): string {
  if (selection.mode === "lifetime") {
    return "Lifetime";
  }

  return selection.mode === "rolling"
    ? ROLLING_LABELS[selection.range]
    : CALENDAR_LABELS[selection.range];
}

export function buildScopeSearchParams(selection: TimeScopeSelection): URLSearchParams {
  const params = new URLSearchParams();
  params.set("mode", selection.mode);
  params.set("range", selection.range);

  return params;
}

export function isSameScope(left: TimeScopeSelection, right: TimeScopeSelection): boolean {
  return left.mode === right.mode && left.range === right.range;
}
