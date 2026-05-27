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
    return "All Time";
  }

  return selection.mode === "rolling"
    ? ROLLING_LABELS[selection.range]
    : CALENDAR_LABELS[selection.range];
}

export function formatScopeDateTime(value: string, timezone: string): string | null {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  try {
    const formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const parts = formatter.formatToParts(date);

    return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")} ${part(parts, "hour")}:${part(parts, "minute")}:${part(parts, "second")}`;
  } catch {
    return null;
  }
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

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((entry) => entry.type === type)?.value;

  if (!value) {
    throw new Error(`Missing ${type} in formatted date parts.`);
  }

  return value;
}
