import { describe, expect, it } from "vitest";
import {
  createDesktopMetricsSnapshot,
  updateDesktopMetricsSnapshot
} from "./orb-snapshot.js";

describe("orb snapshot", () => {
  it("stores metrics and marks the snapshot ready after an update", () => {
    const updatedAt = "2026-06-05T09:30:00.000Z";
    const metrics = {
      totalTokens: 1200,
      totalCostUsd: 1.25,
      activeTasks: 3,
      completedTasks: 8,
      pendingApprovals: 1
    };

    const snapshot = updateDesktopMetricsSnapshot(
      createDesktopMetricsSnapshot(),
      metrics,
      updatedAt
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.metrics.totalTokens).toBe(1200);
    expect(snapshot.metrics.totalCostUsd).toBe(1.25);
    expect(snapshot.metrics.activeTasks).toBe(3);
    expect(snapshot.metrics.completedTasks).toBe(8);
    expect(snapshot.metrics.pendingApprovals).toBe(1);
    expect(snapshot.updatedAt).toBe(updatedAt);
  });
});
