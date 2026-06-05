import { describe, expect, it } from "vitest";
import {
  createDesktopMetricsSnapshot,
  updateDesktopMetricsSnapshot
} from "./orb-snapshot.js";

describe("orb snapshot", () => {
  it("creates a loading snapshot with zeroed metrics", () => {
    const snapshot = createDesktopMetricsSnapshot();

    expect(snapshot.status).toBe("loading");
    expect(snapshot.metrics.totalTokens).toBe(0);
    expect(snapshot.metrics.totalToolCalls).toBe(0);
    expect(snapshot.metrics.editOperationCount).toBe(0);
    expect(snapshot.metrics.affectedFileCount).toBe(0);
    expect(snapshot.metrics.insertions).toBe(0);
    expect(snapshot.metrics.deletions).toBe(0);
    expect(snapshot.metrics.successRate).toBe(0);
    expect(snapshot.metrics.failedExecutions).toBe(0);
    expect(snapshot.metrics.averageDurationMs).toBe(0);
    expect(snapshot.updatedAt).toBeNull();
  });

  it("stores metrics and marks the snapshot ready after an update", () => {
    const updatedAt = "2026-06-05T09:30:00.000Z";
    const metrics = {
      totalTokens: 1200,
      totalToolCalls: 24,
      editOperationCount: 7,
      affectedFileCount: 3,
      insertions: 180,
      deletions: 42,
      successRate: 0.9,
      failedExecutions: 2,
      averageDurationMs: 850
    };

    const snapshot = updateDesktopMetricsSnapshot(
      createDesktopMetricsSnapshot(),
      metrics,
      updatedAt
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.metrics.totalTokens).toBe(1200);
    expect(snapshot.metrics.totalToolCalls).toBe(24);
    expect(snapshot.metrics.editOperationCount).toBe(7);
    expect(snapshot.metrics.affectedFileCount).toBe(3);
    expect(snapshot.metrics.insertions).toBe(180);
    expect(snapshot.metrics.deletions).toBe(42);
    expect(snapshot.metrics.successRate).toBe(0.9);
    expect(snapshot.metrics.failedExecutions).toBe(2);
    expect(snapshot.metrics.averageDurationMs).toBe(850);
    expect(snapshot.updatedAt).toBe(updatedAt);
  });
});
