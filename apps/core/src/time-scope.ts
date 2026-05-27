export type TimeScopeMode = "calendar" | "rolling" | "lifetime";
export type TimeScopeRange = "day" | "week" | "month";

export type ResolvedTimeScope = {
  mode: TimeScopeMode;
  range: TimeScopeRange;
  timezone: string;
  windowStart: string | null;
  windowEnd: string | null;
};

export function resolveTimeScope(
  query: Record<string, unknown>,
  input: {
    now?: Date;
    timezone?: string;
    offsetMinutes?: number;
  } = {}
): ResolvedTimeScope {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMinutes = input.offsetMinutes ?? -now.getTimezoneOffset();
  const mode = normalizeMode(query.mode);
  const range = normalizeRange(query.range);

  if (mode === "lifetime") {
    return {
      mode,
      range,
      timezone,
      windowStart: null,
      windowEnd: null
    };
  }

  const windowEnd = now.toISOString();
  const windowStart =
    mode === "rolling"
      ? resolveRollingWindowStart(now, range)
      : resolveCalendarWindowStart(now, range, offsetMinutes);

  return {
    mode,
    range,
    timezone,
    windowStart,
    windowEnd
  };
}

function normalizeMode(value: unknown): TimeScopeMode {
  return value === "rolling" || value === "lifetime" ? value : "calendar";
}

function normalizeRange(value: unknown): TimeScopeRange {
  return value === "week" || value === "month" ? value : "day";
}

function resolveCalendarWindowStart(now: Date, range: TimeScopeRange, offsetMinutes: number): string {
  const localNow = shiftDate(now, offsetMinutes);
  const year = localNow.getUTCFullYear();
  const month = localNow.getUTCMonth();
  const day = localNow.getUTCDate();

  if (range === "day") {
    return localMidnightToUtcIso(year, month, day, offsetMinutes);
  }

  if (range === "week") {
    const localDay = localNow.getUTCDay();
    const mondayOffsetDays = (localDay + 6) % 7;
    const monday = new Date(Date.UTC(year, month, day - mondayOffsetDays));

    return localMidnightToUtcIso(
      monday.getUTCFullYear(),
      monday.getUTCMonth(),
      monday.getUTCDate(),
      offsetMinutes
    );
  }

  return localMidnightToUtcIso(year, month, 1, offsetMinutes);
}

function resolveRollingWindowStart(now: Date, range: TimeScopeRange): string {
  const durationMs =
    range === "day" ? 24 * 60 * 60 * 1000 : range === "week" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;

  return new Date(now.getTime() - durationMs).toISOString();
}

function shiftDate(date: Date, offsetMinutes: number): Date {
  return new Date(date.getTime() + offsetMinutes * 60_000);
}

function localMidnightToUtcIso(
  year: number,
  month: number,
  day: number,
  offsetMinutes: number
): string {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - offsetMinutes * 60_000).toISOString();
}
