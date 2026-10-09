import { syncCursorOfficialUsage } from "@agent-metrics/adapters-cursor";
import type { SqliteDatabaseLike } from "./domain-types.js";
import { persistCursorAccountUsage } from "./cursor-account-usage.js";

const DEFAULT_REFRESH_MS = 30_000;

export type CursorOfficialRefreshHandle = {
  stop: () => void;
};

/**
 * Lightweight loop: refresh Cursor official quota + today's model tokens only.
 * Codex/OpenCode incremental catch-up lives in `source-light-refresh.ts`.
 */
export function startCursorOfficialRefreshLoop(
  db: SqliteDatabaseLike,
  options: {
    intervalMs?: number;
    timeZone?: string;
    sourceInstanceId?: string;
    log?: { warn: (message: string) => void };
  } = {}
): CursorOfficialRefreshHandle {
  const intervalMs = normalizeInterval(options.intervalMs);
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const sourceInstanceId = options.sourceInstanceId ?? "cursor:default";
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const snapshot = await syncCursorOfficialUsage({
        sourceInstanceId,
        timeZone
      });
      if (!snapshot || stopped) {
        return;
      }
      // Yield once so /api/health can run between network work and sqlite writes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (stopped) {
        return;
      }
      persistCursorAccountUsage(db, snapshot);
    } catch (error) {
      options.log?.warn(
        `cursor official refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      inFlight = false;
    }
  };

  // Defer the first pull so listen()/health are not competing with startup sync.
  initialTimer = setTimeout(() => {
    initialTimer = null;
    if (stopped) {
      return;
    }
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }, 5_000);

  return {
    stop: () => {
      stopped = true;
      if (initialTimer !== null) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

function normalizeInterval(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 5_000) {
    return Math.trunc(value);
  }
  const fromEnv = Number(process.env.AGENT_METRICS_CURSOR_OFFICIAL_REFRESH_MS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 5_000) {
    return Math.trunc(fromEnv);
  }
  return DEFAULT_REFRESH_MS;
}
