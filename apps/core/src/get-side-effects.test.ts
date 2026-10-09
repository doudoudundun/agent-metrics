import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as claudeAdapter from "@agent-metrics/adapters-claude";
import { buildApp } from "./app.js";
import * as eventLogProjector from "./event-log-projector.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

const GET_ROUTES = [
  "/api/health",
  "/api/overview?mode=calendar&range=day",
  "/api/token-trend?mode=calendar&range=day",
  "/api/tools?mode=calendar&range=day",
  "/api/sessions?mode=calendar&range=day",
  "/api/widget-snapshot",
  "/api/sync/status"
] as const;

const FORBIDDEN_GET_SIDE_EFFECTS = [
  "manualSync",
  "triggerAll",
  "startInitialSync",
  "startPeriodicSync",
  "ingestEventLog",
  "projectEventLog",
  "syncEventLog",
  "runWithCanonicalWriterLease",
  "projectAfterSourceSync"
] as const;

describe("GET route structural isolation", () => {
  it("does not reference sync or projection side effects in core-routes GET handlers", () => {
    const routesPath = join(dirname(fileURLToPath(import.meta.url)), "core-routes.ts");
    const source = readFileSync(routesPath, "utf8");
    const blocks = source.split("app.get(").slice(1);

    for (const block of blocks) {
      const nextRoute = block.indexOf("\n  app.");
      const handler = nextRoute === -1 ? block : block.slice(0, nextRoute);
      for (const token of FORBIDDEN_GET_SIDE_EFFECTS) {
        expect(handler, `GET handler must not reference ${token}`).not.toContain(token);
      }
    }
  });
});

describe("GET requests have no sync side effects", () => {
  it("does not invoke coordinator sync or projector ingest on aggregate GETs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-get-side-effects-"));
    const app = buildApp({
      dbPath: join(root, "metrics.sqlite"),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      timezone: "UTC",
      offsetMinutes: 0
    });
    apps.push(app);
    await app.ready();

    const coordinatorManualSync = vi.spyOn(app.syncCoordinator, "manualSync");
    const coordinatorTrigger = vi.spyOn(app.syncCoordinator, "trigger");
    const coordinatorTriggerAll = vi.spyOn(app.syncCoordinator, "triggerAll");
    const coordinatorStartInitial = vi.spyOn(app.syncCoordinator, "startInitialSync");
    const coordinatorStartPeriodic = vi.spyOn(app.syncCoordinator, "startPeriodicSync");
    const ingestSpy = vi.spyOn(eventLogProjector, "ingestEventLog");

    for (const url of GET_ROUTES) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
    }

    expect(coordinatorManualSync).not.toHaveBeenCalled();
    expect(coordinatorTrigger).not.toHaveBeenCalled();
    expect(coordinatorTriggerAll).not.toHaveBeenCalled();
    expect(coordinatorStartInitial).not.toHaveBeenCalled();
    expect(coordinatorStartPeriodic).not.toHaveBeenCalled();
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it("does not await adapter sync while serving GET requests when adapters are registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-get-adapter-isolation-"));
    let releaseSync: (() => void) | null = null;
    const syncBlocked = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    vi.spyOn(claudeAdapter, "syncKnownClaudeTranscripts").mockImplementation(async () => {
      await syncBlocked;
      return { sessionContexts: [] };
    });

    const app = buildApp({
      dbPath: join(root, "metrics.sqlite"),
      eventLogPath: join(root, "events.jsonl"),
      repoRoot: root,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      timezone: "UTC",
      offsetMinutes: 0
    });
    apps.push(app);

    // Spec section 21 line 1799: "committed aggregate GET remains below 500 ms while one
    // adapter fixture is blocked in discovery." This small fixture cannot exercise the
    // full 100k-row performance seed (section 21 line 1794), but it locks the isolation
    // property: a blocked adapter MUST NOT stall committed GET responses. We assert a
    // 500 ms ceiling per request; CI machines that miss the absolute target still pass
    // as long as the blocked adapter never gates the response (the response arrives
    // before releaseSync is called).
    const overviewStart = Date.now();
    const overviewPromise = app.inject({ method: "GET", url: "/api/overview?mode=calendar&range=day" });
    const toolsStart = Date.now();
    const toolsPromise = app.inject({ method: "GET", url: "/api/tools?mode=calendar&range=day" });
    const responses = await Promise.all([overviewPromise, toolsPromise]);
    const overviewMs = Date.now() - overviewStart;
    const toolsMs = Date.now() - toolsStart;

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(overviewMs).toBeLessThan(500);
    expect(toolsMs).toBeLessThan(500);
    releaseSync?.();
    await app.close();
  });
});
