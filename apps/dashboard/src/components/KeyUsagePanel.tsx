import type { ReactNode } from "react";
import type { KeyUsageEntry, KeyUsageResponse, KeyUsageWindow } from "@agent-metrics/contracts";
import "./key-usage.css";

export type KeyUsagePanelProps = {
  data?: KeyUsageResponse | null;
  loading?: boolean;
  errorMessage?: string | null;
  /** Extra cards (e.g. the Cursor account quota) rendered before the entries. */
  leadCards?: ReactNode;
  /** Injection point for deterministic countdown rendering in tests. */
  now?: Date | (() => Date);
};

const VENDOR_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  cursor: "Cursor",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  kimicode: "Kimi Code",
  mimo: "MiMo",
  zcode: "ZCode",
  dsh: "DSH",
  workbuddy: "WorkBuddy"
};

const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

const ABSOLUTE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short"
};

export function KeyUsagePanel({ data, loading = false, errorMessage = null, leadCards, now }: KeyUsagePanelProps) {
  const entries = data?.entries ?? [];
  const displayCards = buildDisplayCards(entries);
  const hasCards = displayCards.length > 0 || leadCards != null;
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
      {!loading && !errorMessage && !hasCards ? (
        <p className="panel-empty">No official key usage data yet.</p>
      ) : null}

      {!loading && !errorMessage && hasCards ? (
        <ul className="key-usage-list" aria-label="Official key quota windows">
          {leadCards}
          {displayCards.map((card) => (
            <li className="key-usage-card" key={card.key}>
              <div className="key-usage-card__head">
                <strong className="key-usage-card__vendor">{formatVendor(card.vendor)}</strong>
                <span className="key-usage-card__limit">{card.limitLabel}</span>
                {creditsState(card.credits) === "available" || creditsState(card.credits) === "unlimited" ? (
                  <span className="key-usage-card__credits" data-state={creditsState(card.credits)}>
                    {formatCredits(card.credits)}
                  </span>
                ) : null}
              </div>
              {card.groups.length > 0 ? (
                <div className="key-usage-card__groups">
                  {card.groups.map((group) => (
                    <div className="key-usage-group" key={group.key}>
                      <div className="key-usage-group__title">{group.title}</div>
                      <div className="key-usage-group__windows">
                        {group.windows.length > 0 ? (
                          group.windows.map((windowItem) => (
                            <QuotaWindow
                              key={windowItem.key}
                              label={windowItem.label}
                              window={windowItem.window}
                              now={resolvedNow}
                              ariaLabel={windowItem.ariaLabel}
                              showWindowLength={windowItem.showWindowLength}
                            />
                          ))
                        ) : (
                          <p className="key-usage-card__empty">No quota windows reported.</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="key-usage-card__windows">
                  {card.windows.map((windowItem) => (
                    <QuotaWindow
                      key={windowItem.key}
                      label={windowItem.label}
                      window={windowItem.window}
                      now={resolvedNow}
                      ariaLabel={windowItem.ariaLabel}
                      showWindowLength={windowItem.showWindowLength}
                    />
                  ))}
                  {card.windows.length === 0 ? (
                    <p className="key-usage-card__empty">No quota windows reported.</p>
                  ) : null}
                </div>
              )}
              {card.expiresAt ? (
                <p className="key-usage-card__expires">
                  Valid until {formatLocalTime(new Date(card.expiresAt))}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

type DisplayCardWindow = {
  key: string;
  label: string;
  window: KeyUsageWindow;
  ariaLabel?: string;
  showWindowLength?: boolean;
};

type DisplayCardGroup = {
  key: string;
  title: string;
  windows: DisplayCardWindow[];
};

type DisplayCard = {
  key: string;
  vendor: string;
  limitLabel: string;
  credits: KeyUsageEntry["credits"];
  expiresAt: string | null;
  windows: DisplayCardWindow[];
  groups: DisplayCardGroup[];
};

function QuotaWindow({
  label,
  window,
  now,
  ariaLabel,
  showWindowLength = true
}: {
  label: string;
  window: KeyUsageWindow;
  now: Date;
  ariaLabel?: string;
  showWindowLength?: boolean;
}) {
  const usedPercent = Math.max(0, window.usedPercent);
  const barWidth = Math.min(100, usedPercent);
  const windowLength = showWindowLength ? formatWindowLength(window.windowMinutes) : null;

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
        aria-label={ariaLabel ?? `${label} quota used`}
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

function buildDisplayCards(entries: KeyUsageEntry[]): DisplayCard[] {
  const entriesByVendor = new Map<string, KeyUsageEntry[]>();
  for (const entry of entries) {
    const existing = entriesByVendor.get(entry.vendor);
    if (existing === undefined) {
      entriesByVendor.set(entry.vendor, [entry]);
    } else {
      existing.push(entry);
    }
  }

  const cards: DisplayCard[] = [];
  for (const [vendor, vendorEntries] of entriesByVendor.entries()) {
    if (vendorEntries.length === 1) {
      const entry = vendorEntries[0]!;
      cards.push({
        key: `${vendor}-${entry.limitId ?? "default"}`,
        vendor,
        limitLabel: entry.limitName ?? entry.limitId ?? "Default limit",
        credits: entry.credits,
        expiresAt: entry.expiresAt,
        windows: buildSingleEntryWindows(entry),
        groups: []
      });
      continue;
    }

    const allSingleWindow = vendorEntries.every(
      (entry) => (entry.primary !== null) !== (entry.secondary !== null)
    );
    if (vendor !== "antigravity" && allSingleWindow) {
      cards.push(buildMergedSingleWindowCard(vendor, vendorEntries));
      continue;
    }

    cards.push(buildMultiPoolCard(vendor, vendorEntries));
  }

  return cards;
}

function buildSingleEntryWindows(entry: KeyUsageEntry): DisplayCardWindow[] {
  const windows: DisplayCardWindow[] = [];
  if (entry.primary !== null) {
    windows.push({ key: "primary", label: "Primary window", window: entry.primary });
  }
  if (entry.secondary !== null) {
    windows.push({ key: "secondary", label: "Secondary window", window: entry.secondary });
  }
  return windows;
}

function buildMergedSingleWindowCard(vendor: string, vendorEntries: KeyUsageEntry[]): DisplayCard {
  const windows: DisplayCardWindow[] = [];
  let credits: KeyUsageEntry["credits"] = null;
  let expiresAt: string | null = null;

  for (const entry of vendorEntries) {
    const pending = [entry.primary, entry.secondary].filter(
      (window): window is KeyUsageWindow => window !== null
    );
    for (const window of pending) {
      if (windows.length === 0) {
        windows.push({ key: "primary", label: "Primary window", window });
      } else if (windows.length === 1) {
        windows.push({ key: "secondary", label: "Secondary window", window });
      }
    }
    if (credits === null && entry.credits !== null) {
      credits = entry.credits;
    }
    if (expiresAt === null && entry.expiresAt !== null) {
      expiresAt = entry.expiresAt;
    }
  }

  return {
    key: `${vendor}-default`,
    vendor,
    limitLabel: "Default limit",
    credits,
    expiresAt,
    windows,
    groups: []
  };
}

function buildMultiPoolCard(vendor: string, vendorEntries: KeyUsageEntry[]): DisplayCard {
  const sortedEntries = [...vendorEntries].sort(comparePoolEntries);
  let usableCredits: KeyUsageEntry["credits"] = null;
  let fallbackCredits: KeyUsageEntry["credits"] = null;
  let expiresAt: string | null = null;

  for (const entry of sortedEntries) {
    const state = creditsState(entry.credits);
    if (usableCredits === null && (state === "available" || state === "unlimited")) {
      usableCredits = entry.credits;
    }
    if (fallbackCredits === null && entry.credits !== null) {
      fallbackCredits = entry.credits;
    }
    if (expiresAt === null && entry.expiresAt !== null) {
      expiresAt = entry.expiresAt;
    }
  }

  const groups: DisplayCardGroup[] = sortedEntries.map((entry, groupIndex) => {
    const title = entry.limitName ?? entry.limitId ?? "Default limit";
    const rawWindows = [
      { slotLabel: "Primary window", window: entry.primary },
      { slotLabel: "Secondary window", window: entry.secondary }
    ].filter(
      (item): item is { slotLabel: string; window: KeyUsageWindow } => item.window !== null
    );

    return {
      key: `${entry.limitId ?? title}-${groupIndex}`,
      title,
      windows: rawWindows.map(({ slotLabel, window }, windowIndex) => {
        const windowLength = formatWindowLength(window.windowMinutes);
        const displayLabel = windowLength ?? slotLabel;
        return {
          key: `${slotLabel}-${window.windowMinutes}-${windowIndex}`,
          label: displayLabel,
          window,
          showWindowLength: false,
          ariaLabel: `${title} ${displayLabel} quota used`
        };
      })
    };
  });

  return {
    key: `${vendor}-pools`,
    vendor,
    limitLabel: `${sortedEntries.length} pools`,
    credits: usableCredits ?? fallbackCredits,
    expiresAt,
    windows: [],
    groups
  };
}

function comparePoolEntries(left: KeyUsageEntry, right: KeyUsageEntry): number {
  const activityDiff = Number(isEntryActive(right)) - Number(isEntryActive(left));
  if (activityDiff !== 0) {
    return activityDiff;
  }
  const rankDiff = poolSortRank(left.limitId) - poolSortRank(right.limitId);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const leftLabel = left.limitName ?? left.limitId ?? "";
  const rightLabel = right.limitName ?? right.limitId ?? "";
  return leftLabel.localeCompare(rightLabel);
}

function isEntryActive(entry: KeyUsageEntry): boolean {
  return isWindowActive(entry.primary) || isWindowActive(entry.secondary);
}

function isWindowActive(window: KeyUsageWindow | null): boolean {
  return window !== null && (window.usedPercent > 0 || window.resetsAt !== null);
}

function poolSortRank(limitId: string | null): number {
  if (limitId === "gemini") {
    return 0;
  }
  if (limitId !== null && limitId.startsWith("gemini-")) {
    return 1;
  }
  if (limitId === "3p") {
    return 2;
  }
  if (limitId === "claude") {
    return 3;
  }
  if (limitId === "gpt") {
    return 4;
  }
  return 5;
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
    return "Synced from provider sources";
  }
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return "Synced from provider sources";
  }
  return `Synced from provider sources · Updated ${formatLocalTime(parsed)}`;
}

function creditsState(credits: KeyUsageEntry["credits"]): string {
  if (credits === null) {
    return "unknown";
  }
  if (credits.unlimited) {
    return "unlimited";
  }
  return credits.hasCredits ? "available" : "none";
}

function formatCredits(credits: KeyUsageEntry["credits"]): string {
  if (credits === null) {
    return "Credits unknown";
  }
  if (credits.unlimited) {
    return "Unlimited credits";
  }
  return credits.hasCredits ? "Credits available" : "No extra credits";
}