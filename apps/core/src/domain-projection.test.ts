import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { NormalizedEventV2 } from "@agent-metrics/event-schema";
import { runDomainMigrations, type SqliteDatabaseLike } from "./domain-migrations.js";
import { projectNormalizedEvents } from "./domain-projection.js";

const baseEvent = {
  schema_version: 2 as const,
  session_id: "session-1",
  source_vendor: "claude-code" as const,
  source_adapter: "claude-hook" as const,
  source_instance_id: "claude:default",
  adapter_instance_id: "claude-hook@claude:default",
  source_record_namespace: "hook",
  source_record_id: "record-1",
  workspace_path: "."
};

function createDb(): SqliteDatabaseLike {
  return new Database(":memory:") as unknown as SqliteDatabaseLike;
}

function event<T extends NormalizedEventV2["type"]>(
  input: Omit<Extract<NormalizedEventV2, { type: T }>, keyof typeof baseEvent | "event_id"> & {
    event_id: string;
  }
): NormalizedEventV2 {
  return { ...baseEvent, ...input } as NormalizedEventV2;
}

describe("canonical V2 projection", () => {
  it("projects observations, lifecycle, and usage idempotently", () => {
    const db = createDb();
    runDomainMigrations(db);

    const events: NormalizedEventV2[] = [
      event({
        event_id: "event-session",
        source_record_id: "session-record",
        timestamp: "2026-07-17T10:00:00.000Z",
        type: "session.started"
      }),
      event({
        event_id: "event-tool-start",
        source_record_id: "tool-record-start",
        timestamp: "2026-07-17T10:00:01.000Z",
        type: "tool.called",
        tool_call_id: "native:tool-1",
        tool_name: "Read",
        status: "started",
        argument_summary: "{}"
      }),
      event({
        event_id: "event-tool-end",
        source_record_id: "tool-record-end",
        timestamp: "2026-07-17T10:00:02.000Z",
        type: "tool.succeeded",
        tool_call_id: "native:tool-1",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 1000
      }),
      event({
        event_id: "event-usage",
        source_record_id: "usage-record",
        timestamp: "2026-07-17T10:00:03.000Z",
        type: "token.usage.recorded",
        message_id: "message-1",
        model: "sonnet",
        input_tokens: 120,
        input_token_semantics: "gross",
        usage_measurement: "increment",
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        server_tool_use: "{}",
        usage_source: "claude-transcript",
        provider_id: "unknown"
      })
    ];

    projectNormalizedEvents(db, events);
    projectNormalizedEvents(db, events);

    expect(db.prepare("SELECT COUNT(*) AS count FROM normalized_events").get()).toEqual({ count: 4 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_observations").get()).toEqual({ count: 4 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT status, started_at, finished_at, duration_ms FROM tool_calls")
        .get()
    ).toEqual({
      status: "succeeded",
      started_at: "2026-07-17T10:00:01.000Z",
      finished_at: "2026-07-17T10:00:02.000Z",
      duration_ms: 1000
    });
    expect(db.prepare("SELECT displayed_input_tokens FROM usage_events").get()).toEqual({
      displayed_input_tokens: 100
    });

    db.close();
  });

  it("heals a null usage model_id on replay without overwriting a known model", () => {
    const db = createDb();
    runDomainMigrations(db);

    const usageEvent = (model: string | null): NormalizedEventV2 =>
      event({
        event_id: "event-usage-heal",
        source_record_id: "usage-record",
        timestamp: "2026-07-17T10:00:03.000Z",
        type: "token.usage.recorded",
        message_id: "message-1",
        model,
        input_tokens: 120,
        input_token_semantics: "gross",
        usage_measurement: "increment",
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        server_tool_use: "{}",
        usage_source: "claude-transcript",
        provider_id: "unknown"
      });

    projectNormalizedEvents(db, [usageEvent(null)]);
    expect(db.prepare("SELECT model_id FROM usage_events").get()).toEqual({ model_id: null });

    projectNormalizedEvents(db, [usageEvent("glm-5.3")]);
    expect(db.prepare("SELECT model_id FROM usage_events").get()).toEqual({ model_id: "glm-5.3" });

    projectNormalizedEvents(db, [usageEvent("glm-5.3-flash")]);
    expect(db.prepare("SELECT model_id FROM usage_events").get()).toEqual({ model_id: "glm-5.3" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });

    db.close();
  });

  it("prefers the terminal event duration_ms over the startedAt/finishedAt delta", () => {
    const db = createDb();
    runDomainMigrations(db);

    // terminal duration_ms (999) deliberately diverges from the 1000ms timestamp
    // delta so this locks in "field wins" behavior and guards against regressing
    // back to durationBetween(startedAt, finishedAt).
    projectNormalizedEvents(db, [
      event({
        event_id: "event-tool-start",
        source_record_id: "tool-record-start",
        timestamp: "2026-07-17T10:00:01.000Z",
        type: "tool.called",
        tool_call_id: "native:tool-duration",
        tool_name: "Read",
        status: "started",
        argument_summary: "{}"
      }),
      event({
        event_id: "event-tool-end",
        source_record_id: "tool-record-end",
        timestamp: "2026-07-17T10:00:02.000Z",
        type: "tool.succeeded",
        tool_call_id: "native:tool-duration",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 999
      })
    ]);

    expect(
      db
        .prepare("SELECT duration_ms FROM tool_calls WHERE tool_call_id = ?")
        .get("native:tool-duration")
    ).toEqual({ duration_ms: 999 });

    db.close();
  });

  it("recomputes terminal-before-start lifecycle in timestamp order", () => {
    const db = createDb();
    runDomainMigrations(db);

    projectNormalizedEvents(db, [
      event({
        event_id: "event-terminal",
        source_record_id: "terminal",
        timestamp: "2026-07-17T10:00:02.000Z",
        type: "tool.succeeded",
        tool_call_id: "native:tool-2",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 0
      }),
      event({
        event_id: "event-start",
        source_record_id: "start",
        timestamp: "2026-07-17T10:00:01.000Z",
        type: "tool.called",
        tool_call_id: "native:tool-2",
        tool_name: "Read",
        status: "started",
        argument_summary: "{}"
      })
    ]);

    expect(
      db.prepare("SELECT status, started_at, finished_at FROM tool_calls WHERE tool_call_id = ?").get("native:tool-2")
    ).toEqual({
      status: "succeeded",
      started_at: "2026-07-17T10:00:01.000Z",
      finished_at: "2026-07-17T10:00:02.000Z"
    });

    db.close();
  });

  it("records a semantic identity conflict and does not replace the canonical row", () => {
    const db = createDb();
    runDomainMigrations(db);

    const first = event({
      event_id: "event-conflict",
      timestamp: "2026-07-17T10:00:01.000Z",
      type: "tool.called",
      tool_call_id: "native:tool-3",
      tool_name: "Read",
      status: "started",
      argument_summary: "{}"
    });
    const conflicting = { ...first, tool_name: "Write" };

    projectNormalizedEvents(db, [first]);
    projectNormalizedEvents(db, [conflicting]);

    expect(db.prepare("SELECT COUNT(*) AS count FROM event_diagnostics WHERE diagnostic_code = ?").get("IDENTITY_CONFLICT")).toEqual({ count: 1 });
    expect(db.prepare("SELECT tool_name FROM tool_calls WHERE tool_call_id = ?").get("native:tool-3")).toEqual({
      tool_name: "Read"
    });

    db.close();
  });

  it("aliases an unambiguous Claude hook fallback to a transcript native identity", () => {
    const db = createDb();
    runDomainMigrations(db);

    projectNormalizedEvents(db, [
      event({
        event_id: "hook-start",
        source_record_id: "hook-start",
        timestamp: "2026-07-17T10:00:00.000Z",
        source_adapter: "claude-hook",
        tool_call_id: "derived:hook-1",
        type: "tool.called",
        tool_name: "Read",
        status: "started",
        argument_summary: "{}"
      }),
      event({
        event_id: "transcript-end",
        source_record_id: "transcript-end",
        timestamp: "2026-07-17T10:00:02.000Z",
        source_adapter: "claude-transcript",
        adapter_instance_id: "claude-transcript@claude:default",
        tool_call_id: "native:transcript-1",
        type: "tool.succeeded",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 2000
      })
    ]);

    expect(db.prepare("SELECT observed_tool_call_id, canonical_tool_call_id FROM tool_call_aliases").all()).toEqual([
      { observed_tool_call_id: "derived:hook-1", canonical_tool_call_id: "native:transcript-1" }
    ]);
    expect(db.prepare("SELECT tool_call_id, status FROM tool_calls").all()).toEqual([
      { tool_call_id: "native:transcript-1", status: "succeeded" }
    ]);

    db.close();
  });

  it("keeps ambiguous Claude fallback candidates separate and records a diagnostic", () => {
    const db = createDb();
    runDomainMigrations(db);

    projectNormalizedEvents(db, [
      event({
        event_id: "ambiguous-hook-start",
        source_record_id: "ambiguous-hook-start",
        timestamp: "2026-07-17T10:00:00.000Z",
        source_adapter: "claude-hook",
        tool_call_id: "derived:hook-ambiguous",
        type: "tool.called",
        tool_name: "Read",
        status: "started",
        argument_summary: "{}"
      }),
      event({
        event_id: "ambiguous-transcript-end-1",
        source_record_id: "ambiguous-transcript-end-1",
        timestamp: "2026-07-17T10:00:01.000Z",
        source_adapter: "claude-transcript",
        adapter_instance_id: "claude-transcript@claude:default",
        tool_call_id: "native:transcript-ambiguous-1",
        type: "tool.succeeded",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 1000
      }),
      event({
        event_id: "ambiguous-transcript-end-2",
        source_record_id: "ambiguous-transcript-end-2",
        timestamp: "2026-07-17T10:00:02.000Z",
        source_adapter: "claude-transcript",
        adapter_instance_id: "claude-transcript@claude:default",
        tool_call_id: "native:transcript-ambiguous-2",
        type: "tool.succeeded",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 2000
      })
    ]);

    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_call_aliases").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_calls").get()).toEqual({ count: 3 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM event_diagnostics WHERE diagnostic_code = 'AMBIGUOUS_TOOL_ALIAS'").get()
    ).toEqual({ count: 1 });

    db.close();
  });

  it("revokes a Claude alias when a later observation makes the match ambiguous", () => {
    const db = createDb();
    runDomainMigrations(db);

    const hook = event({
      event_id: "revocation-hook-start",
      source_record_id: "revocation-hook-start",
      timestamp: "2026-07-17T10:00:00.000Z",
      source_adapter: "claude-hook",
      tool_call_id: "derived:hook-revocation",
      type: "tool.called",
      tool_name: "Read",
      status: "started",
      argument_summary: "{}"
    });
    const firstTranscript = event({
      event_id: "revocation-transcript-end-1",
      source_record_id: "revocation-transcript-end-1",
      timestamp: "2026-07-17T10:00:02.000Z",
      source_adapter: "claude-transcript",
      adapter_instance_id: "claude-transcript@claude:default",
      tool_call_id: "native:transcript-revocation-1",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 2000
    });

    projectNormalizedEvents(db, [hook, firstTranscript]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_call_aliases").get()).toEqual({ count: 1 });

    projectNormalizedEvents(db, [
      event({
        event_id: "revocation-transcript-end-2",
        source_record_id: "revocation-transcript-end-2",
        timestamp: "2026-07-17T10:00:03.000Z",
        source_adapter: "claude-transcript",
        adapter_instance_id: "claude-transcript@claude:default",
        tool_call_id: "native:transcript-revocation-2",
        type: "tool.succeeded",
        tool_name: "Read",
        status: "succeeded",
        duration_ms: 3000
      })
    ]);

    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_call_aliases").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tool_calls").get()).toEqual({ count: 3 });

    db.close();
  });

  it("seeds started_at from the first non-lifecycle event but keeps session.started authoritative", () => {
    const db = createDb();
    runDomainMigrations(db);

    // Transcript-style stream: no session.started at all, so the first
    // observed event must anchor the session window.
    projectNormalizedEvents(db, [
      event({
        event_id: "seed-usage",
        source_record_id: "seed-usage",
        timestamp: "2026-07-17T10:00:00.000Z",
        type: "token.usage.recorded",
        message_id: "message-1",
        model: "sonnet",
        input_tokens: 10,
        input_token_semantics: "delta",
        usage_measurement: "increment",
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: "{}",
        usage_source: "claude-transcript",
        provider_id: "unknown"
      })
    ]);
    expect(
      db.prepare("SELECT started_at FROM domain_sessions WHERE session_id = ?").get("session-1")
    ).toEqual({ started_at: "2026-07-17T10:00:00.000Z" });

    // A later session.started announcement refines the anchor to the earlier
    // of the two timestamps, and a late junk timestamp cannot drag it back.
    projectNormalizedEvents(db, [
      event({
        event_id: "seed-session",
        source_record_id: "seed-session",
        timestamp: "2026-07-17T09:59:00.000Z",
        type: "session.started"
      }),
      event({
        event_id: "seed-late",
        source_record_id: "seed-late",
        timestamp: "2026-07-17T11:00:00.000Z",
        type: "prompt.submitted",
        prompt_id: "prompt-1",
        prompt_chars: 4
      })
    ]);
    expect(
      db.prepare("SELECT started_at FROM domain_sessions WHERE session_id = ?").get("session-1")
    ).toEqual({ started_at: "2026-07-17T09:59:00.000Z" });

    db.close();
  });
});
