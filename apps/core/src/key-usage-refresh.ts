import type { SqliteDatabaseLike } from "./domain-types.js";
import { collectAntigravityKeyUsage } from "./official-key-usage-antigravity.js";
import { collectKimicodeKeyUsage } from "./official-key-usage-kimicode.js";
import { collectZCodeApiKeyUsage } from "./official-key-usage-zcode-api.js";

const DEFAULT_REFRESH_MS = 60_000;
const MIN_REFRESH_MS = 15_000;
const DEFAULT_INITIAL_DELAY_MS = 1_500;
const DEFAULT_MIN_TRIGGER_INTERVAL_MS = 15_000;

export type OfficialKeyUsageVendor = "kimicode" | "zcode" | "antigravity";

const ALL_VENDORS: readonly OfficialKeyUsageVendor[] = [
  "kimicode",
  "zcode",
  "antigravity"
];

export type KeyUsageRefreshHandle = {
  stop: () => void;
  triggerNow: (options?: {
    force?: boolean;
    vendor?: OfficialKeyUsageVendor;
  }) => Promise<void>;
};

export type OfficialKeyUsageCollectors = Partial<
  Record<OfficialKeyUsageVendor, (db: SqliteDatabaseLike) => Promise<unknown>>
>;

/**
 * Network-side official key quota refresh (Kimi Code, ZCode API, Antigravity).
 * Local log scrapers (Codex rollouts, ZCode billing logs) ride the source
 * light refresh loop.
 */
export function startOfficialKeyUsageRefreshLoop(
  db: SqliteDatabaseLike,
  options: {
    intervalMs?: number;
    initialDelayMs?: number;
    minTriggerIntervalMs?: number;
    now?: () => number;
    collectors?: OfficialKeyUsageCollectors;
    log?: { warn: (message: string) => void; info?: (message: string) => void };
  } = {}
): KeyUsageRefreshHandle {
  const intervalMs = normalizeInterval(options.intervalMs);
  const initialDelayMs = normalizeNonNegativeDuration(
    options.initialDelayMs,
    DEFAULT_INITIAL_DELAY_MS
  );
  const minTriggerIntervalMs = normalizeNonNegativeDuration(
    options.minTriggerIntervalMs,
    DEFAULT_MIN_TRIGGER_INTERVAL_MS
  );
  const now = options.now ?? (() => Date.now());
  const collectors: Record<OfficialKeyUsageVendor, (db: SqliteDatabaseLike) => Promise<unknown>> = {
    kimicode: (targetDb) =>
      options.collectors?.kimicode
        ? options.collectors.kimicode(targetDb)
        : collectKimicodeKeyUsage(targetDb, { log: options.log }),
    zcode: (targetDb) =>
      options.collectors?.zcode
        ? options.collectors.zcode(targetDb)
        : collectZCodeApiKeyUsage(targetDb, { log: options.log }),
    antigravity: (targetDb) =>
      options.collectors?.antigravity
        ? options.collectors.antigravity(targetDb)
        : collectAntigravityKeyUsage(targetDb, { log: options.log })
  };

  let stopped = false;
  const inFlightByVendor = new Map<OfficialKeyUsageVendor, Promise<void>>();
  const lastCompletedAt = new Map<OfficialKeyUsageVendor, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;

  const runVendor = async (
    vendor: OfficialKeyUsageVendor,
    { force }: { force: boolean }
  ): Promise<void> => {
    if (stopped) {
      return;
    }
    const existing = inFlightByVendor.get(vendor);
    if (existing !== undefined) {
      return existing;
    }
    if (!force) {
      const lastCompleted = lastCompletedAt.get(vendor);
      if (lastCompleted !== undefined && now() - lastCompleted < minTriggerIntervalMs) {
        return;
      }
    }

    const run = (async () => {
      try {
        await collectors[vendor](db);
      } catch (error) {
        options.log?.warn(
          `${vendor} key usage refresh failed: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        lastCompletedAt.set(vendor, now());
        inFlightByVendor.delete(vendor);
      }
    })();

    inFlightByVendor.set(vendor, run);
    return run;
  };

  const tick = async () => {
    if (stopped) {
      return;
    }
    for (const vendor of ALL_VENDORS) {
      if (stopped) {
        break;
      }
      await runVendor(vendor, { force: false });
    }
  };

  // Defer the first pull briefly so listen()/health are not competing with startup sync.
  initialTimer = setTimeout(() => {
    initialTimer = null;
    if (stopped) {
      return;
    }
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }, initialDelayMs);

  return {
    triggerNow: async ({ force = false, vendor } = {}) => {
      if (stopped) {
        return;
      }
      if (vendor !== undefined) {
        await runVendor(vendor, { force });
        return;
      }
      await Promise.all(ALL_VENDORS.map((targetVendor) => runVendor(targetVendor, { force })));
    },
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
  if (typeof value === "number" && Number.isFinite(value) && value >= MIN_REFRESH_MS) {
    return Math.trunc(value);
  }
  const fromEnv = Number(process.env.AGENT_METRICS_KEY_USAGE_REFRESH_MS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= MIN_REFRESH_MS) {
    return Math.trunc(fromEnv);
  }
  return DEFAULT_REFRESH_MS;
}

function normalizeNonNegativeDuration(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return fallback;
}
