import {
  addPersonalQuotaSample,
  antigravityLimitIdForModel,
  emptyPersonalQuotaFit,
  estimatePersonalQuotaPercent,
  personalQuotaCoefficients
} from "@agent-metrics/contracts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { persistOfficialKeyUsage } from "./official-key-usage.js";
import { selectPersonalQuota } from "./personal-quota.js";

describe("personal quota", () => {
  it("maps Antigravity models onto the official quota families", () => {
    expect(antigravityLimitIdForModel("gemini-4-neon-high")).toBe("gemini");
    expect(antigravityLimitIdForModel("ag/gemini-4-argon-high")).toBe("gemini-argon");
    expect(antigravityLimitIdForModel("gemini-4-carbon")).toBe("gemini-carbon");
    expect(antigravityLimitIdForModel("claude-opus-5-5-high")).toBe("3p");
    expect(antigravityLimitIdForModel("unknown")).toBeNull();
  });

  it("uses one rate until token mixes can separate the weights", () => {
    const once = addPersonalQuotaSample(
      emptyPersonalQuotaFit(),
      { uncached: 100, cacheRead: 0, output: 0 },
      5
    );
    expect(personalQuotaCoefficients(once)).toEqual({ uncached: 0.05, cacheRead: 0.05, output: 0.05 });

    const separated = (
      [
        [{ uncached: 1, cacheRead: 0, output: 0 }, 2],
        [{ uncached: 0, cacheRead: 1, output: 0 }, 3],
        [{ uncached: 0, cacheRead: 0, output: 1 }, 4]
      ] as const
    ).reduce(
      (fit, [tokens, meter]) => addPersonalQuotaSample(fit, tokens, meter),
      emptyPersonalQuotaFit()
    );
    const weights = personalQuotaCoefficients(separated);
    expect(weights?.uncached).toBeCloseTo(2);
    expect(weights?.cacheRead).toBeCloseTo(3);
    expect(weights?.output).toBeCloseTo(4);
    expect(estimatePersonalQuotaPercent({ uncached: 10, cacheRead: 10, output: 10 }, weights!)).toBeCloseTo(90);
  });

  it("sums this machine's Antigravity increments inside the weekly window", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE usage_events (
        source_vendor TEXT,
        usage_measurement TEXT,
        occurred_at TEXT,
        model_id TEXT,
        displayed_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        output_tokens INTEGER
      );
    `);
    const insert = db.prepare(
      `INSERT INTO usage_events (
        source_vendor, usage_measurement, occurred_at, model_id,
        displayed_input_tokens, cache_read_input_tokens, output_tokens
      ) VALUES (?, 'increment', ?, ?, ?, ?, ?)`
    );
    insert.run("antigravity", "2026-11-19T00:00:00.000Z", "gemini-4-neon-high", 9, 0, 1);
    insert.run("antigravity", "2026-11-21T00:00:00.000Z", "gemini-4-neon-high", 2, 4, 1);
    insert.run("antigravity", "2026-11-21T00:00:00.000Z", "claude-opus-5-5", 3, 0, 1);
    insert.run("codex", "2026-11-21T00:00:00.000Z", "gemini-4-neon-high", 50, 0, 0);

    persistOfficialKeyUsage(db, [
      {
        vendor: "antigravity",
        source: "antigravity-quota-api",
        limitId: "gemini",
        limitName: "Gemini Models",
        primary: { usedPercent: 10, windowMinutes: 300, resetsAt: "2026-11-27T08:00:00.000Z" },
        secondary: { usedPercent: 38, windowMinutes: 10080, resetsAt: "2026-11-27T03:08:52.000Z" },
        credits: null,
        expiresAt: null,
        observedAt: "2026-11-27T02:19:01.000Z"
      },
      {
        vendor: "antigravity",
        source: "antigravity-quota-api",
        limitId: "3p",
        limitName: "Claude and GPT models",
        primary: null,
        secondary: { usedPercent: 4, windowMinutes: 10080, resetsAt: "2026-11-27T03:08:52.000Z" },
        credits: null,
        expiresAt: null,
        observedAt: "2026-11-27T02:19:01.000Z"
      }
    ]);

    const report = selectPersonalQuota(db, new Date("2026-11-27T04:00:00.000Z"));
    expect(report.families).toEqual([
      {
        limitId: "3p",
        limitName: "Claude and GPT models",
        accountUsedPercent: 4,
        resetsAt: "2026-11-27T03:08:52.000Z",
        windowStart: "2026-11-20T03:08:52.000Z",
        tokens: { uncached: 3, cacheRead: 0, output: 1 }
      },
      {
        limitId: "gemini",
        limitName: "Gemini Models",
        accountUsedPercent: 38,
        resetsAt: "2026-11-27T03:08:52.000Z",
        windowStart: "2026-11-20T03:08:52.000Z",
        tokens: { uncached: 2, cacheRead: 4, output: 1 }
      }
    ]);
    db.close();
  });
});
