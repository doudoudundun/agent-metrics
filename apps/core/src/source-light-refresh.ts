const DEFAULT_REFRESH_MS = 30_000;
/** Run full Codex ledger reconcile about every 5 minutes when light interval is 30s. */
const FULL_RECONCILE_EVERY_TICKS = 10;

export type SourceLightRefreshHandle = {
  stop: () => void;
};

export type SourceLightRefreshTick = (input: {
  reconcileRecent: boolean;
}) => Promise<void>;

export type IsolatedSourceRefreshTask = {
  id: string;
  run: () => Promise<void>;
};

/**
 * Run each source independently so one adapter failure cannot starve the rest.
 * Callers should mark success only through `onSuccess`.
 */
export async function runIsolatedSourceRefreshTasks(
  tasks: IsolatedSourceRefreshTask[],
  options: {
    log?: { warn: (message: string) => void };
    onSuccess: (id: string) => void;
  }
): Promise<void> {
  for (const task of tasks) {
    try {
      await task.run();
      options.onSuccess(task.id);
    } catch (error) {
      options.log?.warn(
        `source light refresh failed for ${task.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

/**
 * Lightweight loop for Codex + OpenCode/ZCode/Kimi Code incremental catch-up.
 * Skips heavy recent-rollout reconcile on most ticks; periodically heals drift.
 */
export function startSourceLightRefreshLoop(
  tick: SourceLightRefreshTick,
  options: {
    intervalMs?: number;
    fullReconcileEveryTicks?: number;
    log?: { warn: (message: string) => void };
  } = {}
): SourceLightRefreshHandle {
  const intervalMs = normalizeInterval(options.intervalMs);
  const fullReconcileEveryTicks = normalizeTickCount(
    options.fullReconcileEveryTicks,
    FULL_RECONCILE_EVERY_TICKS
  );
  let stopped = false;
  let inFlight = false;
  let tickCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;

  const runTick = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    tickCount += 1;
    const reconcileRecent = tickCount % fullReconcileEveryTicks === 0;
    try {
      await tick({ reconcileRecent });
    } catch (error) {
      options.log?.warn(
        `source light refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      inFlight = false;
    }
  };

  initialTimer = setTimeout(() => {
    initialTimer = null;
    if (stopped) {
      return;
    }
    void runTick();
    timer = setInterval(() => {
      void runTick();
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
  const fromEnv = Number(process.env.AGENT_METRICS_SOURCE_LIGHT_REFRESH_MS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 5_000) {
    return Math.trunc(fromEnv);
  }
  return DEFAULT_REFRESH_MS;
}

function normalizeTickCount(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.trunc(value);
  }
  return fallback;
}
