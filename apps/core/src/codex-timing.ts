import type { MetricsDatabase } from "./core-types.js";

type TimedUsage = {
  source_vendor: string;
  usage_source: string;
  source_instance_id?: string;
  session_id?: string;
  created_at: string;
  decode_duration_ms: number | null;
  first_token_latency_ms: number | null;
};

type ToolTiming = { started_at: string | null; finished_at: string | null };
type Interval = { start: number; end: number };

/**
 * Earlier Codex rollouts measured the wall time between usage reports, including
 * intervening tools. Exclude those historical timing samples at query time;
 * leave event payloads, counters, and ingestion fingerprints intact.
 */
export function excludeCodexToolTiming<T extends TimedUsage>(
  db: MetricsDatabase,
  rows: readonly T[]
): T[] {
  const intervalsBySession = new Map<string, Interval[]>();
  const selectTools = db.prepare<ToolTiming>(
    `SELECT started_at, finished_at FROM tool_calls
     WHERE source_instance_id = ? AND session_id = ?`
  );

  return rows.map((row) => {
    if (row.source_vendor !== "codex" || row.usage_source !== "codex-rollout" ||
        !row.source_instance_id || !row.session_id ||
        (row.decode_duration_ms === null && row.first_token_latency_ms === null)) {
      return row;
    }
    const end = Date.parse(row.created_at);
    if (!Number.isFinite(end)) return row;

    const key = JSON.stringify([row.source_instance_id, row.session_id]);
    let intervals = intervalsBySession.get(key);
    if (intervals === undefined) {
      intervals = mergeIntervals(selectTools.all(row.source_instance_id, row.session_id));
      intervalsBySession.set(key, intervals);
    }

    const crossesTool = (duration: number | null): boolean =>
      duration !== null && Number.isFinite(duration) && duration >= 0 &&
      overlaps(intervals, end - duration, end);
    const decode = crossesTool(row.decode_duration_ms) ? null : row.decode_duration_ms;
    const ttft = crossesTool(row.first_token_latency_ms) ? null : row.first_token_latency_ms;
    if (decode === row.decode_duration_ms && ttft === row.first_token_latency_ms) return row;
    return { ...row, decode_duration_ms: decode, first_token_latency_ms: ttft };
  });
}

function mergeIntervals(tools: readonly ToolTiming[]): Interval[] {
  const intervals: Interval[] = [];
  for (const tool of tools) {
    const start = tool.started_at === null ? NaN : Date.parse(tool.started_at);
    const end = tool.finished_at === null ? NaN : Date.parse(tool.finished_at);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      intervals.push({ start: Math.min(start, end), end: Math.max(start, end) });
    } else if (Number.isFinite(start) || Number.isFinite(end)) {
      // An unpaired boundary proves a tool event, not an indefinitely running
      // tool. Do not discard all later measurements in an unfinished session.
      const point = Number.isFinite(start) ? start : end;
      intervals.push({ start: point, end: point });
    }
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function overlaps(intervals: readonly Interval[], start: number, end: number): boolean {
  // Merged intervals have monotonically increasing end points.
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (intervals[middle].end < start) low = middle + 1;
    else high = middle;
  }
  return low < intervals.length && intervals[low].start <= end;
}
