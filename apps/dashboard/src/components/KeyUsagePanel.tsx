import type { KeyUsageEntry, KeyUsageResponse, KeyUsageWindow } from "@agent-metrics/contracts";
import "./key-usage.css";

export type KeyUsagePanelProps = {
  data?: KeyUsageResponse | null;
  loading?: boolean;
  errorMessage?: string | null;
  /** Injection point for deterministic countdown rendering in tests. */
  now?: Date | (() => Date);
};

const VENDOR_LABELS: Record<string, string> = {
  codex: "Codex",
  cursor: "Cursor",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  kimicode: "Kimi Code",
  mimo: "MiMo",
  zcode: "ZCode",
  dsh: "DSH"
};

const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

const ABSOLUTE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short"
};

export function KeyUsagePanel({ data, loading = false, errorMessage = null, now }: KeyUsagePanelProps) {
  const entries = data?.entries ?? [];
  const displayEntries = mergeVendorWindowEntries(entries);
  const resolvedNow = typeof now === "function" ? now() : now ?? new Date();

  return (
    <section className="panel key-usage-panel" aria-label="Official key usage">
      <header className="key-usage-panel__header">
        <div className="key-usage-panel__title">
          <span className="key-usage-panel__eyebrow">Official keys</span>
          <h2>Key usage &amp; limits</h2>
        </div>
        <span className="key-usage-panel__meta">
          {formatUpdatedAt(data?.updatedAt ?? null)}
        </span>
      </header>

      {loading ? <p className="panel-empty">Loading key usage...</p> : null}
      {!loading && errorMessage ? <p className="panel-empty key-usage-panel__error">{errorMessage}</p> : null}
      {!loading && !errorMessage && displayEntries.length === 0 ? (
        <p className="panel-empty">No official key usage data yet.</p>
      ) : null}

      {!loading && !errorMessage && displayEntries.length > 0 ? (
        <ul className="key-usage-list" aria-label="Official key quota windows">
          {displayEntries.map((entry, index) => (
            <li className="key-usage-card" key={`${entry.vendor}-${entry.limitId ?? "default"}-${index}`}>
              <div className="key-usage-card__head">
                <strong className="key-usage-card__vendor">{formatVendor(entry.vendor)}</strong>
                <span className="key-usage-card__limit">
                  {entry.limitName ?? entry.limitId ?? "Default limit"}
                </span>
                <span className="key-usage-card__credits" data-state={creditsState(entry)}>
                  {formatCredits(entry)}
                </span>
              </div>
              <div className="key-usage-card__windows">
                {entry.primary !== null ? (
                  <QuotaWindow label="Primary window" window={entry.primary} now={resolvedNow} />
                ) : null}
                {entry.secondary !== null ? (
                  <QuotaWindow label="Secondary window" window={entry.secondary} now={resolvedNow} />
                ) : null}
                {entry.primary === null && entry.secondary === null ? (
                  <p className="key-usage-card__empty">No quota windows reported.</p>
                ) : null}
              </div>
              {entry.expiresAt ? (
                <p className="key-usage-card__expires">
                  Valid until {formatLocalTime(new Date(entry.expiresAt))}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function QuotaWindow({ label, window, now }: { label: string; window: KeyUsageWindow; now: Date }) {
  const usedPercent = Math.max(0, window.usedPercent);
  const barWidth = Math.min(100, usedPercent);
  const windowLength = formatWindowLength(window.windowMinutes);

  return (
    <div className="key-usage-window">
      <div className="key-usage-window__head">
        <span className="key-usage-window__label">
          {label}
          {windowLength === null ? null : (
            <span className="key-usage-window__length"> · {windowLength}</span>
          )}
        </span>
        <span className="key-usage-window__percent">{formatPercent(usedPercent)}</span>
      </div>
      <div
        className="key-usage-window__bar"
        role="progressbar"
        aria-label={`${label} quota used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barWidth)}
      >
        <span
          className="key-usage-window__fill"
          data-tone={usedPercent >= 90 ? "danger" : usedPercent >= 70 ? "warn" : "ok"}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <p className="key-usage-window__reset">{formatReset(window.resetsAt, now)}</p>
    </div>
  );
}

function mergeVendorWindowEntries(entries: KeyUsageEntry[]): KeyUsageEntry[] {
  const windowedCountByVendor = new Map<string, number>();
  for (const entry of entries) {
    if (entry.primary !== null || entry.secondary !== null) {
      windowedCountByVendor.set(entry.vendor, (windowedCountByVendor.get(entry.vendor) ?? 0) + 1);
    }
  }

  const mergedByVendor = new Map<string, KeyUsageEntry>();
  const result: KeyUsageEntry[] = [];
  for (const entry of entries) {
    const hasWindow = entry.primary !== null || entry.secondary !== null;
    if (!hasWindow || (windowedCountByVendor.get(entry.vendor) ?? 0) < 2) {
      result.push(entry);
      continue;
    }

    const existing = mergedByVendor.get(entry.vendor);
    if (existing === undefined) {
      const merged: KeyUsageEntry = {
        ...entry,
        limitId: null,
        limitName: null,
        primary: entry.primary ?? entry.secondary,
        secondary: entry.primary !== null ? entry.secondary : null
      };
      mergedByVendor.set(entry.vendor, merged);
      result.push(merged);
      continue;
    }

    const pending = [entry.primary, entry.secondary].filter(
      (window): window is KeyUsageWindow => window !== null
    );
    for (const window of pending) {
      if (existing.primary === null) {
        existing.primary = window;
      } else if (existing.secondary === null) {
        existing.secondary = window;
      }
    }
    if (existing.credits === null && entry.credits !== null) {
      existing.credits = entry.credits;
    }
    if (existing.expiresAt === null && entry.expiresAt !== null) {
      existing.expiresAt = entry.expiresAt;
    }
  }
  return result;
}

function formatVendor(vendor: string): string {
  const label = VENDOR_LABELS[vendor.toLowerCase()];
  if (label !== undefined) {
    return label;
  }
  return vendor.length === 0 ? "Unknown vendor" : vendor;
}

function formatPercent(value: number): string {
  return `${PERCENT_FORMAT.format(value)}%`;
}

function formatWindowLength(windowMinutes: number): string | null {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null;
  }
  if (windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d window`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h window`;
  }
  return `${windowMinutes}m window`;
}

function formatReset(resetsAt: string | null, now: Date): string {
  if (resetsAt === null) {
    return "Reset time unknown";
  }
  const resetAt = new Date(resetsAt);
  if (Number.isNaN(resetAt.getTime())) {
    return "Reset time unknown";
  }

  const absolute = formatLocalTime(resetAt);
  const remainingMs = resetAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return `Window expired · ${absolute}`;
  }
  return `Resets in ${formatCountdown(remainingMs)} · ${absolute}`;
}

function formatCountdown(remainingMs: number): string {
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m`;
  }
  return "under a minute";
}

function formatLocalTime(value: Date): string {
  return value.toLocaleString(undefined, ABSOLUTE_TIME_FORMAT);
}

function formatUpdatedAt(updatedAt: string | null): string {
  if (updatedAt === null) {
    return "Synced from local rollout logs";
  }
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return "Synced from local rollout logs";
  }
  return `Synced from local rollout logs · Updated ${formatLocalTime(parsed)}`;
}

function creditsState(entry: KeyUsageEntry): string {
  if (entry.credits === null) {
    return "unknown";
  }
  if (entry.credits.unlimited) {
    return "unlimited";
  }
  return entry.credits.hasCredits ? "available" : "none";
}

function formatCredits(entry: KeyUsageEntry): string {
  if (entry.credits === null) {
    return "Credits unknown";
  }
  if (entry.credits.unlimited) {
    return "Unlimited credits";
  }
  return entry.credits.hasCredits ? "Credits available" : "No extra credits";
}