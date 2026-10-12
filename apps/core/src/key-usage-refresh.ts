import type { SqliteDatabaseLike } from "./domain-types.js";
import { collectKimicodeKeyUsage } from "./official-key-usage-kimicode.js";
import { collectZCodeApiKeyUsage } from "./official-key-usage-zcode-api.js";

const DEFAULT_REFRESH_MS = 5 * 60_000;

export type KeyUsageRefreshHandle = {
  stop: () => void;
};

/**
 * Network-side official key quota refresh (Kimi Code). Local log scrapers
 * (Codex rollouts, ZCode billing logs) ride the source light refresh loop.
 */
export function startOfficialKeyUsageRefreshLoop(
  db: SqliteDatabaseLike,
  options: {
    intervalMs?: number;
    log?: { warn: (message: string) => void; info?: (message: string) => void };
  } = {}
): KeyUsageRefreshHandle {
  const intervalMs = normalizeInterval(options.intervalMs);
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
      await collectKimicodeKeyUsage(db, { log: options.log });
      await collectZCodeApiKeyUsage(db, { log: options.log });
    } catch (error) {
      options.log?.warn(
        `official key usage refresh failed: ${error instanceof Error ? error.message : String(error)}`
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
  if (typeof value === "number" && Number.isFinite(value) && value >= 60_000) {
    return Math.trunc(value);
  }
  const fromEnv = Number(process.env.AGENT_METRICS_KEY_USAGE_REFRESH_MS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 60_000) {
    return Math.trunc(fromEnv);
  }
  return DEFAULT_REFRESH_MS;
}
