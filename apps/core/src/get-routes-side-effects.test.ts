import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as claudeAdapter from "@agent-metrics/adapters-claude";
import * as codexAdapter from "@agent-metrics/adapters-codex";
import * as opencodeAdapter from "@agent-metrics/adapters-opencode";
import * as kimicodeAdapter from "@agent-metrics/adapters-kimicode";
import * as mimoAdapter from "@agent-metrics/adapters-mimo";
import * as dshAdapter from "@agent-metrics/adapters-dsh";
import * as cursorAdapter from "@agent-metrics/adapters-cursor";
import * as workbuddyAdapter from "@agent-metrics/adapters-workbuddy";
import * as codebuddyLogAdapter from "@agent-metrics/adapters-codebuddy-log";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import { buildApp } from "./app.js";
import * as eventLogProjector from "./event-log-projector.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET routes have no synchronization side effects", () => {
  it("does not invoke adapters, projection, or coordinator mutations on read routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-get-side-effects-"));
    const dbPath = join(root, "metrics.sqlite");
    const eventLogPath = join(root, "events.jsonl");

    await appendJsonLine(eventLogPath, {
      event_id: "evt-get-side-effect",
      session_id: "session-1",
      timestamp: "2026-07-17T10:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: root,
      type: "session.started"
    });

    const claudeSpy = vi.spyOn(claudeAdapter, "syncKnownClaudeTranscripts").mockResolvedValue({ sessionContexts: [] });
    const opencodeSpy = vi.spyOn(opencodeAdapter, "syncOpenCodeDatabase").mockResolvedValue(undefined);
    const zcodeSpy = vi.spyOn(opencodeAdapter, "syncZCodeDatabase").mockResolvedValue(undefined);
    const kimicodeSpy = vi.spyOn(kimicodeAdapter, "syncKimicodeSessions").mockResolvedValue(undefined);
    const mimoSpy = vi.spyOn(mimoAdapter, "syncMiMoDatabase").mockResolvedValue(undefined);
    const dshSpy = vi.spyOn(dshAdapter, "syncDshSessions").mockResolvedValue(undefined);
    const codexSpy = vi.spyOn(codexAdapter, "syncCodexRollouts").mockResolvedValue(undefined);
    const cursorSpy = vi.spyOn(cursorAdapter, "syncCursorArtifacts").mockResolvedValue(undefined);
    const cursorOfficialSpy = vi.spyOn(cursorAdapter, "syncCursorOfficialUsage").mockResolvedValue(null);
    const workbuddySpy = vi
      .spyOn(workbuddyAdapter, "syncWorkbuddySessions")
      .mockResolvedValue(undefined);
    const codebuddyLogSpy = vi
      .spyOn(codebuddyLogAdapter, "syncCodebuddyCliLogs")
      .mockResolvedValue({ filesScanned: 0, requestsWritten: 0, requestsSkippedAsDuplicate: 0 });
    const ingestSpy = vi.spyOn(eventLogProjector, "ingestEventLog");

    const app = buildApp({
      dbPath,
      eventLogPath,
      repoRoot: root,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      timezone: "UTC",
      offsetMinutes: 0
    });
    apps.push(app);
    await app.ready();

    const initialSyncRuns = app.syncCoordinator.startInitialSync().runs.map((run) => run.runId);
    await waitForSyncRuns(app, initialSyncRuns);

    claudeSpy.mockClear();
    opencodeSpy.mockClear();
    zcodeSpy.mockClear();
    kimicodeSpy.mockClear();
    mimoSpy.mockClear();
    dshSpy.mockClear();
    codexSpy.mockClear();
    cursorSpy.mockClear();
    workbuddySpy.mockClear();
    codebuddyLogSpy.mockClear();
    ingestSpy.mockClear();

    const triggerSpy = vi.spyOn(app.syncCoordinator, "trigger");
    const manualSyncSpy = vi.spyOn(app.syncCoordinator, "manualSync");
    const startInitialSyncSpy = vi.spyOn(app.syncCoordinator, "startInitialSync");
    const startPeriodicSyncSpy = vi.spyOn(app.syncCoordinator, "startPeriodicSync");

    const getRoutes = [
      "/api/health",
      "/api/widget-snapshot",
      "/api/sync/status",
      "/api/overview?mode=calendar&range=day",
      "/api/token-trend?mode=calendar&range=day",
      "/api/tools?mode=calendar&range=day",
      "/api/sessions?mode=calendar&range=day",
      "/api/exports/json",
      "/api/exports/csv",
      "/api/sessions/session-1"
    ] as const;

    for (const url of getRoutes) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBeLessThan(500);
    }

    const runId = initialSyncRuns[0];
    if (runId !== undefined) {
      const runResponse = await app.inject({ method: "GET", url: `/api/sync/runs/${runId}` });
      expect(runResponse.statusCode).toBe(200);
    }

    expect(claudeSpy).not.toHaveBeenCalled();
    expect(opencodeSpy).not.toHaveBeenCalled();
    expect(zcodeSpy).not.toHaveBeenCalled();
    expect(kimicodeSpy).not.toHaveBeenCalled();
    expect(mimoSpy).not.toHaveBeenCalled();
    expect(dshSpy).not.toHaveBeenCalled();
    expect(codexSpy).not.toHaveBeenCalled();
    expect(cursorSpy).not.toHaveBeenCalled();
    expect(workbuddySpy).not.toHaveBeenCalled();
    expect(codebuddyLogSpy).not.toHaveBeenCalled();
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(triggerSpy).not.toHaveBeenCalled();
    expect(manualSyncSpy).not.toHaveBeenCalled();
    expect(startInitialSyncSpy).not.toHaveBeenCalled();
    expect(startPeriodicSyncSpy).not.toHaveBeenCalled();
  });
});

async function waitForSyncRuns(
  app: ReturnType<typeof buildApp>,
  runIds: string[],
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = runIds.every((runId) => {
      const status = app.syncCoordinator.getRun(runId)?.status;
      return status === "succeeded" || status === "failed" || status === "aborted";
    });
    if (terminal) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Sync runs did not reach a terminal state before timeout.");
}
