export type TimeScopeMode = "calendar" | "rolling" | "lifetime" | "custom";
export type TimeScopeRange = "day" | "week" | "month";

export type PresetTimeScope = {
  mode: "calendar" | "rolling" | "lifetime";
  range: TimeScopeRange;
};

export type CustomTimeScope = {
  mode: "custom";
  startAt: string;
  endAt: string;
};

export type TimeScopeSelection = PresetTimeScope | CustomTimeScope;

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

  if (selection.mode === "custom") {
    const start = toLocalDateInputValue(new Date(selection.startAt));
    const end = toLocalDateInputValue(new Date(selection.endAt));
    return start === end ? start : `${start} – ${end}`;
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
  if (selection.mode === "custom") {
    params.set("startAt", selection.startAt);
    params.set("endAt", selection.endAt);
    return params;
  }
  params.set("range", selection.range);
  return params;
}

export function isSameScope(left: TimeScopeSelection, right: TimeScopeSelection): boolean {
  if (left.mode === "custom" || right.mode === "custom") {
    return (
      left.mode === "custom" &&
      right.mode === "custom" &&
      left.startAt === right.startAt &&
      left.endAt === right.endAt
    );
  }
  return left.mode === right.mode && left.range === right.range;
}

export function scopeCacheKey(selection: TimeScopeSelection): string {
  if (selection.mode === "custom") {
    return `custom:${selection.startAt}:${selection.endAt}`;
  }
  return `${selection.mode}:${selection.range}`;
}

export function toLocalDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localDayStartIso(dateYmd: string): string {
  return new Date(`${dateYmd}T00:00:00`).toISOString();
}

export function localDayEndIso(dateYmd: string): string {
  return new Date(`${dateYmd}T23:59:59.999`).toISOString();
}

export function customScopeFromLocalDates(startDate: string, endDate: string): CustomTimeScope {
  const start = startDate <= endDate ? startDate : endDate;
  const end = startDate <= endDate ? endDate : startDate;
  return {
    mode: "custom",
    startAt: localDayStartIso(start),
    endAt: localDayEndIso(end)
  };
}

export function defaultCustomScope(now: Date = new Date()): CustomTimeScope {
  const end = toLocalDateInputValue(now);
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 6);
  return customScopeFromLocalDates(toLocalDateInputValue(startDate), end);
}

export function customScopeLocalDates(selection: CustomTimeScope): { startDate: string; endDate: string } {
  return {
    startDate: toLocalDateInputValue(new Date(selection.startAt)),
    endDate: toLocalDateInputValue(new Date(selection.endAt))
  };
}

export function toolbarDatesForScope(
  selection: TimeScopeSelection,
  now: Date = new Date()
): { startDate: string; endDate: string } {
  if (selection.mode === "custom") {
    return customScopeLocalDates(selection);
  }
  if (selection.mode === "lifetime") {
    return { startDate: "", endDate: "" };
  }

  const today = toLocalDateInputValue(now);
  if (selection.mode === "calendar") {
    if (selection.range === "day") {
      return { startDate: today, endDate: today };
    }
    if (selection.range === "week") {
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      return { startDate: toLocalDateInputValue(monday), endDate: today };
    }
    return {
      startDate: toLocalDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1)),
      endDate: today
    };
  }

  const lookbackDays = selection.range === "day" ? 1 : selection.range === "week" ? 6 : 29;
  const start = new Date(now);
  start.setDate(now.getDate() - lookbackDays);
  return { startDate: toLocalDateInputValue(start), endDate: today };
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((entry) => entry.type === type)?.value;

  if (!value) {
    throw new Error(`Missing ${type} in formatted date parts.`);
  }

  return value;
}
