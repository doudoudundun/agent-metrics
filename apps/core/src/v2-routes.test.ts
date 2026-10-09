import { appendFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiErrorResponseSchema,
  HealthResponseSchema,
  SessionDetailResponseSchema,
  SessionsResponseSchema,
  WidgetSnapshotResponseSchema
} from "@agent-metrics/contracts";
import { buildApp, ingestEventLog } from "./app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("revision 2 Core routes", () => {
  it("serves health, widget snapshot, and sync status through shared response contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-v2-routes-"));
    const app = buildApp({
      dbPath: join(root, "metrics.sqlite"),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      timezone: "UTC",
      offsetMinutes: 0
    });
    apps.push(app);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(health.json())).toEqual({
      status: "ok",
      apiVersion: 2,
      eventSchemaVersion: 2
    });

    const widget = await app.inject({ method: "GET", url: "/api/widget-snapshot" });
    expect(widget.statusCode).toBe(200);
    expect(WidgetSnapshotResponseSchema.parse(widget.json()).scope).toMatchObject({
      mode: "calendar",
      range: "day"
    });

    const status = await app.inject({ method: "GET", url: "/api/sync/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().adapters).toEqual([]);
    expect(status.headers["cache-control"]).toBe("no-store");
  });

  it("returns immediate manual-sync acceptance and sanitized run errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-v2-sync-"));
    const app = buildApp({ dbPath: join(root, "metrics.sqlite") });
    apps.push(app);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { origin: "http://127.0.0.1" },
      payload: { reason: "manual refresh" }
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().runs).toEqual([]);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/sync",
      headers: { origin: "http://127.0.0.1" },
      payload: { reason: "x".repeat(201) }
    });
    expect(invalid.statusCode).toBe(400);
    expect(ApiErrorResponseSchema.parse(invalid.json()).error.code).toBe("INVALID_REQUEST");

    const missing = await app.inject({ method: "GET", url: "/api/sync/runs/does-not-exist" });
    expect(missing.statusCode).toBe(404);
    expect(ApiErrorResponseSchema.parse(missing.json()).error.code).toBe("SYNC_RUN_NOT_FOUND");
  });

  it("serves bounded composite session details and rejects untrusted origins", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-v2-detail-"));
    const eventLogPath = join(root, "events.jsonl");
    await appendFile(eventLogPath, `${JSON.stringify({
      event_id: "session-start",
      session_id: "session-1",
      timestamp: "2026-07-17T11:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/fixture",
      type: "session.started"
    })}\n${JSON.stringify({
      event_id: "prompt-1",
      session_id: "session-1",
      timestamp: "2026-07-17T11:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/fixture",
      type: "prompt.submitted",
      prompt_id: "prompt-1",
      prompt_chars: 12
    })}\n`);
    const app = buildApp({
      dbPath: join(root, "metrics.sqlite"),
      eventLogPath,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      timezone: "UTC",
      offsetMinutes: 0
    });
    apps.push(app);
    await app.ready();

    const detail = await app.inject({
      method: "GET",
      url: "/api/sources/claude%3Adefault/sessions/session-1?limit=1"
    });
    expect(detail.statusCode).toBe(200);
    expect(SessionDetailResponseSchema.parse(detail.json()).timeline.rows).toHaveLength(1);

    const untrustedHost = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "192.168.1.10:45183" }
    });
    expect(untrustedHost.statusCode).toBe(403);
    expect(ApiErrorResponseSchema.parse(untrustedHost.json()).error.code).toBe("INVALID_REQUEST");

    const untrustedOrigin = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:45183", origin: "https://attacker.invalid" }
    });
    expect(untrustedOrigin.statusCode).toBe(403);

    await ingestEventLog({ app, eventLogPath });
  });

  it("uses composite session identities and filter-bound cursors for session pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-v2-pagination-"));
    const app = buildApp({
      dbPath: join(root, "metrics.sqlite"),
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      timezone: "UTC",
      offsetMinutes: 0
    });
    apps.push(app);
    insertCanonicalSession(app, "claude:alpha", "shared", "claude-code", "claude-transcript");
    insertCanonicalSession(app, "opencode:beta", "shared", "opencode", "opencode-db");
    insertCanonicalSession(app, "claude:gamma", "other", "claude-code", "claude-transcript");
    insertCanonicalEvent(app, "evt-alpha-start", "claude:alpha", "shared", "claude-code", "claude-transcript", "2026-07-17T11:00:00.000Z", "session.started");
    insertCanonicalEvent(app, "evt-alpha-prompt", "claude:alpha", "shared", "claude-code", "claude-transcript", "2026-07-17T11:01:00.000Z", "prompt.submitted");
    insertCanonicalEvent(app, "evt-beta-start", "opencode:beta", "shared", "opencode", "opencode-db", "2026-07-17T11:01:00.000Z", "session.started");
    insertCanonicalEvent(app, "evt-gamma-start", "claude:gamma", "other", "claude-code", "claude-transcript", "2026-07-17T10:00:00.000Z", "session.started");

    const first = await app.inject({
      method: "GET",
      url: "/api/sessions?mode=lifetime&range=day&limit=1"
    });
    expect(first.statusCode).toBe(200);
    const firstPage = SessionsResponseSchema.parse(first.json());
    expect(firstPage.rows).toHaveLength(1);
    expect(firstPage.rows[0]).toMatchObject({
      sourceInstanceId: "claude:alpha",
      sessionId: "shared"
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await app.inject({
      method: "GET",
      url: `/api/sessions?mode=lifetime&range=day&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`
    });
    expect(second.statusCode).toBe(200);
    expect(SessionsResponseSchema.parse(second.json()).rows[0]).toMatchObject({
      sourceInstanceId: "opencode:beta",
      sessionId: "shared"
    });

    const mismatchedFilter = await app.inject({
      method: "GET",
      url: `/api/sessions?mode=lifetime&range=day&sourceVendor=opencode&cursor=${encodeURIComponent(firstPage.nextCursor!)}`
    });
    expect(mismatchedFilter.statusCode).toBe(400);
    expect(ApiErrorResponseSchema.parse(mismatchedFilter.json()).error.code).toBe("INVALID_CURSOR");

    const malformed = await app.inject({
      method: "GET",
      url: "/api/sessions?mode=lifetime&range=day&cursor=not-a-cursor"
    });
    expect(malformed.statusCode).toBe(400);
    expect(ApiErrorResponseSchema.parse(malformed.json()).error.code).toBe("INVALID_CURSOR");

    const detail = await app.inject({
      method: "GET",
      url: "/api/sources/claude%3Aalpha/sessions/shared?mode=lifetime&range=day&limit=1"
    });
    expect(detail.statusCode).toBe(200);
    const detailPage = SessionDetailResponseSchema.parse(detail.json());
    expect(detailPage.timeline.rows.map((row) => row.eventId)).toEqual(["evt-alpha-start"]);
    expect(detailPage.timeline.nextCursor).toEqual(expect.any(String));

    const detailNext = await app.inject({
      method: "GET",
      url: `/api/sources/claude%3Aalpha/sessions/shared?mode=lifetime&range=day&limit=1&cursor=${encodeURIComponent(detailPage.timeline.nextCursor!)}`
    });
    expect(detailNext.statusCode).toBe(200);
    expect(SessionDetailResponseSchema.parse(detailNext.json()).timeline.rows.map((row) => row.eventId)).toEqual([
      "evt-alpha-prompt"
    ]);
  });
});

function insertCanonicalSession(
  app: ReturnType<typeof buildApp>,
  sourceInstanceId: string,
  sessionId: string,
  sourceVendor: "claude-code" | "opencode",
  sourceAdapter: "claude-transcript" | "opencode-db"
): void {
  app.db.prepare(
    `INSERT INTO domain_sessions (
      source_instance_id, session_id, source_vendor, source_adapter, workspace_path, started_at
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sourceInstanceId, sessionId, sourceVendor, sourceAdapter, "D:/fixture", "2026-07-17T10:00:00.000Z");
}

function insertCanonicalEvent(
  app: ReturnType<typeof buildApp>,
  eventId: string,
  sourceInstanceId: string,
  sessionId: string,
  sourceVendor: "claude-code" | "opencode",
  sourceAdapter: "claude-transcript" | "opencode-db",
  timestamp: string,
  eventType: "session.started" | "prompt.submitted"
): void {
  app.db.prepare(
    `INSERT INTO normalized_events (
      event_id, schema_version, session_id, source_instance_id, timestamp, type, event_type,
      source_vendor, source_adapter, adapter_instance_id, source_record_namespace,
      source_record_id, workspace_path, semantic_fingerprint, payload_json, created_at
    ) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture', ?, 'D:/fixture', ?, '{}', ?)`
  ).run(
    eventId,
    sessionId,
    sourceInstanceId,
    timestamp,
    eventType,
    eventType,
    sourceVendor,
    sourceAdapter,
    `${sourceAdapter}@${sourceInstanceId}`,
    eventId,
    `fingerprint-${eventId}`,
    timestamp
  );
}
