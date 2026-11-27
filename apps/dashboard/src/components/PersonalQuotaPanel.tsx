import { personalQuotaUsesSharedRate, type PersonalQuotaFamily } from "@agent-metrics/contracts";
import { useEffect, useState } from "react";
import {
  emptyPersonalQuotaLine,
  finishPersonalQuotaStretch,
  personalLineShouldAlert,
  personalQuotaEstimate,
  readPersonalQuotaLines,
  writePersonalQuotaLines,
  type PersonalQuotaLine
} from "../personal-quota-store";
import "./key-usage.css";

export type PersonalQuotaPanelProps = {
  families: readonly PersonalQuotaFamily[];
  loading?: boolean;
  errorMessage?: string | null;
  storage?: Storage;
};

const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const TOKEN_FORMAT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function formatPercent(value: number): string {
  return `${PERCENT_FORMAT.format(value)}%`;
}

export function PersonalQuotaPanel({
  families,
  loading = false,
  errorMessage = null,
  storage
}: PersonalQuotaPanelProps) {
  const [lines, setLines] = useState(() => readPersonalQuotaLines(storage));
  const [notice, setNotice] = useState<string | null>(null);

  const save = (limitId: string, line: PersonalQuotaLine) => {
    const next = { ...lines, [limitId]: line };
    setLines(next);
    writePersonalQuotaLines(next, storage);
  };

  useEffect(() => {
    let next = lines;
    let changed = false;
    for (const family of families) {
      const line = next[family.limitId] ?? emptyPersonalQuotaLine();
      if (!personalLineShouldAlert(family, line) || line.capPercent === null) {
        continue;
      }
      next = { ...next, [family.limitId]: { ...line, alertedResetsAt: family.resetsAt ?? "" } };
      changed = true;
    }
    if (changed) {
      setLines(next);
      writePersonalQuotaLines(next, storage);
    }
  }, [families, lines, storage]);

  return (
    <section className="panel key-usage-panel" aria-label="Your Antigravity usage">
      <header className="key-usage-panel__header">
        <div className="key-usage-panel__title">
          <span className="key-usage-panel__eyebrow">This machine</span>
          <h2>Your Antigravity usage</h2>
        </div>
      </header>
      <p className="key-usage-card__empty">
        Estimated from Antigravity sessions stored on this machine. The account percentage includes
        everyone on that login.
      </p>
      {loading ? <p className="panel-empty">Loading your usage...</p> : null}
      {!loading && errorMessage ? <p className="panel-empty key-usage-panel__error">{errorMessage}</p> : null}
      {!loading && !errorMessage && families.length === 0 ? (
        <p className="panel-empty">No Antigravity weekly quota yet.</p>
      ) : null}
      {notice ? <p className="key-usage-panel__error">{notice}</p> : null}
      {!loading && !errorMessage && families.length > 0 ? (
        <ul className="key-usage-list">
          {families.map((family) => {
            const line = lines[family.limitId] ?? emptyPersonalQuotaLine();
            const estimate = personalQuotaEstimate(family, line);
            const alert = personalLineShouldAlert(family, line);
            return (
              <li className="key-usage-card" key={family.limitId}>
                <div className="key-usage-card__head">
                  <strong className="key-usage-card__vendor">{family.limitName}</strong>
                  <span className="key-usage-card__limit">
                    {estimate === null ? "No rate yet" : `${formatPercent(estimate)} of this pool`}
                  </span>
                </div>
                <p className="key-usage-card__empty">
                  Account window {formatPercent(family.accountUsedPercent)} used.
                </p>
                <p className="key-usage-card__empty">
                  {TOKEN_FORMAT.format(family.tokens.uncached)} input · {TOKEN_FORMAT.format(family.tokens.cacheRead)}{" "}
                  cache · {TOKEN_FORMAT.format(family.tokens.output)} output
                </p>
                {line.fit.residual !== null && line.fit.samples > 0 ? (
                  <p className="key-usage-card__empty">
                    Last stretch was off by {PERCENT_FORMAT.format(Math.abs(line.fit.residual))} points.
                  </p>
                ) : null}
                {personalQuotaUsesSharedRate(line.fit) ? (
                  <p className="key-usage-card__empty">
                    Input, cache, and output share one rate until stretches with different mixes separate them.
                  </p>
                ) : null}
                {alert ? <p className="key-usage-panel__error">Past your line for this window.</p> : null}
                <div className="key-usage-card__windows">
                  <label className="key-usage-window__label">
                    Remind at
                    <input
                      aria-label={`Remind at percent for ${family.limitName}`}
                      inputMode="numeric"
                      defaultValue={line.capPercent ?? ""}
                      onBlur={(event) => {
                        const parsed = Number.parseInt(event.currentTarget.value, 10);
                        save(family.limitId, {
                          ...line,
                          capPercent: Number.isInteger(parsed) && parsed >= 1 && parsed <= 99 ? parsed : null
                        });
                      }}
                    />
                    %
                  </label>
                  {line.calibration === null ? (
                    <button
                      type="button"
                      onClick={() => {
                        setNotice(null);
                        save(family.limitId, {
                          ...line,
                          calibration: {
                            tokens: family.tokens,
                            usedPercent: family.accountUsedPercent,
                            resetsAt: family.resetsAt
                          }
                        });
                      }}
                    >
                      Start stretch
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const result = finishPersonalQuotaStretch(line, family);
                          if (!result.ok) {
                            setNotice(
                              result.reason === "reset"
                                ? "The account window reset during this stretch. Start again."
                                : result.reason === "meter"
                                  ? "The account window did not move, so this stretch cannot set a rate."
                                  : "This stretch has no new tokens from your sessions."
                            );
                            if (result.reason === "reset") {
                              save(family.limitId, { ...line, calibration: null });
                            }
                            return;
                          }
                          setNotice(null);
                          save(family.limitId, result.line);
                        }}
                      >
                        Finish stretch
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setNotice(null);
                          save(family.limitId, { ...line, calibration: null });
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
                {line.calibration !== null ? (
                  <p className="key-usage-card__empty">
                    Finish only if nobody else used this account during the stretch.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
