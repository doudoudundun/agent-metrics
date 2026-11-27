import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { semanticFingerprint, toNormalizedEventV2, type NormalizedEventV2 } from "@agent-metrics/event-schema";
import { selectTokensByModel } from "./aggregate-queries.js";
import type { MetricsDatabase } from "./core-types.js";
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
  it("merges late WorkBuddy billing, cache, tier and precise timing together and keeps stale replays idempotent", () => {
    const db = createDb();
    runDomainMigrations(db);
    const initial = toNormalizedEventV2({
      event_id: "workbuddy:session-combined:usage:message-1", session_id: "session-combined",
      timestamp: "2026-10-20T02:37:38.535Z", source_vendor: "workbuddy", source_adapter: "workbuddy-jsonl",
      workspace_path: ".", type: "token.usage.recorded", message_id: "message-1", model: "deepseek-v4.1-flash",
      input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: "{}", usage_source: "workbuddy-usage", provider_id: "unknown",
      first_token_latency_ms: null, decode_duration_ms: 5000
    });
    const enriched = { ...initial, service_tier: "fast", credit: 0.42,
      cache_read_input_tokens: 800, first_token_latency_ms: 500, decode_duration_ms: 1000 } as NormalizedEventV2;
    projectNormalizedEvents(db, [initial]);
    expect(projectNormalizedEvents(db, [enriched, initial]).every((result) => result.conflict === false)).toBe(true);
    expect(db.prepare(`SELECT service_tier, credit, displayed_input_tokens, cache_read_input_tokens,
      first_token_latency_ms, decode_duration_ms, output_tokens FROM usage_events`).get())
      .toEqual({ service_tier: "fast", credit: 0.42, displayed_input_tokens: 200,
        cache_read_input_tokens: 800, first_token_latency_ms: 500, decode_duration_ms: 1000, output_tokens: 50 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_diagnostics").get()).toEqual({ count: 0 });
    for (const change of [{ credit: 0.99 }, { cache_read_input_tokens: 801 }, { provider_id: "other" }, { output_tokens: 51 }]) {
      expect(projectNormalizedEvents(db, [{ ...enriched, ...change } as NormalizedEventV2])[0].conflict).toBe(true);
    }
    expect(db.prepare("SELECT credit, cache_read_input_tokens, output_tokens FROM usage_events").get())
      .toEqual({ credit: 0.42, cache_read_input_tokens: 800, output_tokens: 50 });
    db.close();
  });

  it("replaces estimated WorkBuddy decode timing when precise timing and tier arrive together", () => {
    const db = createDb();
    runDomainMigrations(db);
    const estimated = toNormalizedEventV2({
      event_id: "workbuddy:session-precise:usage:message-1", session_id: "session-precise",
      timestamp: "2026-10-20T02:37:38.535Z", source_vendor: "workbuddy", source_adapter: "workbuddy-jsonl",
      workspace_path: ".", type: "token.usage.recorded", message_id: "message-1", model: "deepseek-v4.1-flash",
      input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 800,
      server_tool_use: "{}", usage_source: "workbuddy-usage", provider_id: "unknown",
      first_token_latency_ms: null, decode_duration_ms: 5000
    });
    const precise = { ...estimated, service_tier: "fast", first_token_latency_ms: 500, decode_duration_ms: 1000 } as NormalizedEventV2;
    projectNormalizedEvents(db, [estimated]);
    expect(projectNormalizedEvents(db, [precise])[0].conflict).toBe(false);
    expect(projectNormalizedEvents(db, [estimated])[0].conflict).toBe(false);
    expect(db.prepare("SELECT service_tier, first_token_latency_ms, decode_duration_ms FROM usage_events").get())
      .toEqual({ service_tier: "fast", first_token_latency_ms: 500, decode_duration_ms: 1000 });
    expect(db.prepare("SELECT semantic_fingerprint FROM normalized_events").get())
      .toEqual({ semantic_fingerprint: semanticFingerprint(precise) });
    expect(projectNormalizedEvents(db, [{ ...precise, output_tokens: 51 } as NormalizedEventV2])[0].conflict).toBe(true);
    expect(db.prepare("SELECT count(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    db.close();
  });

  it("backfills WorkBuddy timing consistently without double counting, downgrading or changing usage", () => {
    const db = createDb(); runDomainMigrations(db);
    const original = toNormalizedEventV2({
      event_id: "workbuddy:session-1:usage:message-1", session_id: "session-1",
      timestamp: "2026-10-20T02:37:38.535Z", source_vendor: "workbuddy", source_adapter: "workbuddy-jsonl",
      workspace_path: ".", type: "token.usage.recorded", message_id: "message-1", model: "deepseek-v4.1-flash",
      input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 800,
      server_tool_use: "{}", usage_source: "workbuddy-usage", provider_id: "unknown",
      first_token_latency_ms: null, decode_duration_ms: null
    });
    const enriched = { ...original, first_token_latency_ms: 500, decode_duration_ms: 1000 } as NormalizedEventV2;
    projectNormalizedEvents(db, [original]);
    expect(projectNormalizedEvents(db, [enriched])[0].conflict).toBe(false);
    projectNormalizedEvents(db, [enriched, original]); // stale event-log replay cannot erase timing
    expect(db.prepare("SELECT count(*) AS count, sum(output_tokens) AS tokens FROM usage_events").get())
      .toEqual({ count: 1, tokens: 50 });
    expect(db.prepare("SELECT first_token_latency_ms, decode_duration_ms, semantic_fingerprint FROM usage_events").get())
      .toEqual({ first_token_latency_ms: 500, decode_duration_ms: 1000, semantic_fingerprint: semanticFingerprint(enriched) });
    const stored = db.prepare<{ payload_json: string; semantic_fingerprint: string }>(
      "SELECT payload_json, semantic_fingerprint FROM normalized_events"
    ).get();
    expect(JSON.parse(stored.payload_json)).toEqual(enriched);
    expect(stored.semantic_fingerprint).toBe(semanticFingerprint(enriched));
    expect(db.prepare("SELECT semantic_fingerprint FROM event_observations").get())
      .toEqual({ semantic_fingerprint: semanticFingerprint(enriched) });
    expect(db.prepare("SELECT count(*) AS count FROM event_diagnostics").get()).toEqual({ count: 0 });
    for (const change of [{ output_tokens: 51 }, { model: "other" }, { decode_duration_ms: 2000 }]) {
      expect(projectNormalizedEvents(db, [{ ...enriched, ...change } as NormalizedEventV2])[0].conflict).toBe(true);
    }
    expect(db.prepare("SELECT output_tokens, decode_duration_ms FROM usage_events").get())
      .toEqual({ output_tokens: 50, decode_duration_ms: 1000 });
    db.close();
  });

  it("patches a credit onto a WorkBuddy row that was projected before its billing line", () => {
    const db = createDb(); runDomainMigrations(db);
    const withoutCredit = toNormalizedEventV2({
      event_id: "codebuddy-cli:session-1:usage:message-1", session_id: "session-1",
      timestamp: "2026-10-27T02:57:36.264Z", source_vendor: "workbuddy", source_adapter: "codebuddy-cli-log",
      workspace_path: ".", type: "token.usage.recorded", message_id: "message-1", model: "hy4-preview",
      input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: "{}", usage_source: "codebuddy-log", provider_id: "unknown",
      first_token_latency_ms: 100, decode_duration_ms: 200
    });
    const withCredit = toNormalizedEventV2({
      event_id: "codebuddy-cli:session-1:usage:message-1", session_id: "session-1",
      timestamp: "2026-10-27T02:57:36.264Z", source_vendor: "workbuddy", source_adapter: "codebuddy-cli-log",
      workspace_path: ".", type: "token.usage.recorded", message_id: "message-1", model: "hy4-preview",
      input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: "{}", usage_source: "codebuddy-log", credit: 0.42, provider_id: "unknown",
      first_token_latency_ms: 100, decode_duration_ms: 200
    });

    projectNormalizedEvents(db, [withoutCredit]);
    expect(db.prepare("SELECT credit FROM usage_events").get()).toEqual({ credit: null });

    expect(projectNormalizedEvents(db, [withCredit])[0].conflict).toBe(false);
    expect(db.prepare("SELECT credit, output_tokens FROM usage_events").get())
      .toEqual({ credit: 0.42, output_tokens: 50 });
    expect(db.prepare("SELECT count(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM event_diagnostics").get()).toEqual({ count: 0 });

    // A different credit for the same request stays a real conflict.
    const conflicting = { ...withCredit, credit: 0.99 } as NormalizedEventV2;
    expect(projectNormalizedEvents(db, [conflicting])[0].conflict).toBe(true);
    expect(db.prepare("SELECT credit FROM usage_events").get()).toEqual({ credit: 0.42 });
    db.close();
  });

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

  it("fills a previously missing service tier without duplicating usage or counting an identity conflict", () => {
    const db = createDb();
    runDomainMigrations(db);

    const usageEvent = (
      serviceTier?: string,
      adapter: "claude-hook" | "claude-transcript" = "claude-hook"
    ): NormalizedEventV2 =>
      event({
        event_id: "event-usage-tier-enrichment",
        source_record_id: "usage-tier-record",
        source_adapter: adapter,
        adapter_instance_id: `${adapter}@claude:default`,
        timestamp: "2026-07-17T10:00:03.000Z",
        type: "token.usage.recorded",
        message_id: "message-tier",
        model: "sonnet",
        input_tokens: 120,
        input_token_semantics: "gross",
        usage_measurement: "increment",
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        server_tool_use: "{}",
        usage_source: "claude-transcript",
        provider_id: "unknown",
        ...(serviceTier ? { service_tier: serviceTier } : {})
      });

    const initial = usageEvent();
    const enriched = usageEvent("fast", "claude-transcript");
    const [initialResult] = projectNormalizedEvents(db, [initial]);

    const [result] = projectNormalizedEvents(db, [usageEvent("fast")]);

    expect(result).toMatchObject({ projected: false, idempotent: false, conflict: false });
    expect(
      db.prepare("SELECT semantic_fingerprint FROM event_observations WHERE event_id = ?").all(initial.event_id)
    ).toEqual([{ semantic_fingerprint: initialResult.semanticFingerprint }]);

    const [crossAdapterReplay] = projectNormalizedEvents(db, [enriched]);
    expect(crossAdapterReplay).toMatchObject({ idempotent: true, conflict: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM normalized_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM event_observations WHERE event_id = ?").get(initial.event_id)
    ).toEqual({ count: 2 });
    expect(db.prepare("SELECT SUM(output_tokens) AS output_tokens FROM usage_events").get()).toEqual({ output_tokens: 10 });
    expect(db.prepare("SELECT service_tier FROM usage_events").get()).toEqual({ service_tier: "fast" });
    expect(
      JSON.parse(db.prepare("SELECT payload_json FROM normalized_events WHERE event_id = ?").get("event-usage-tier-enrichment").payload_json)
    ).toMatchObject({ service_tier: "fast", source_adapter: "claude-hook" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_diagnostics WHERE diagnostic_code = 'IDENTITY_CONFLICT'").get()).toEqual({ count: 0 });

    const [replayed] = projectNormalizedEvents(db, [enriched]);
    expect(replayed).toMatchObject({ idempotent: true, conflict: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });

    db.close();
  });

  it("keeps known service tiers and token fields immutable on conflicting replays", () => {
    const db = createDb();
    runDomainMigrations(db);

    const usageEvent = (serviceTier: string, outputTokens = 10): NormalizedEventV2 =>
      event({
        event_id: "event-usage-tier-conflict",
        source_record_id: "usage-tier-conflict-record",
        timestamp: "2026-07-17T10:00:03.000Z",
        type: "token.usage.recorded",
        message_id: "message-tier-conflict",
        model: "sonnet",
        input_tokens: 120,
        input_token_semantics: "gross",
        usage_measurement: "increment",
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        server_tool_use: "{}",
        usage_source: "claude-transcript",
        provider_id: "unknown",
        service_tier: serviceTier
      });

    const canonical = usageEvent("standard");
    projectNormalizedEvents(db, [canonical]);

    const [tierConflict] = projectNormalizedEvents(db, [usageEvent("fast")]);
    const [tokenConflict] = projectNormalizedEvents(db, [usageEvent("standard", 11)]);

    expect(tierConflict.conflict).toBe(true);
    expect(tokenConflict.conflict).toBe(true);
    expect(db.prepare("SELECT service_tier, output_tokens FROM usage_events").get()).toEqual({
      service_tier: "standard",
      output_tokens: 10
    });
    const storedPayload = JSON.parse(
      db.prepare("SELECT payload_json FROM normalized_events WHERE event_id = ?").get("event-usage-tier-conflict").payload_json
    );
    expect(storedPayload).toMatchObject({ service_tier: "standard", output_tokens: 10 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_diagnostics WHERE diagnostic_code = 'IDENTITY_CONFLICT'").get()).toEqual({ count: 2 });

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

  it("backfills Antigravity timing without conflicts or duplicates and ignores stale null replays", () => {
    const db = createDb();
    runDomainMigrations(db);

    const initial = toNormalizedEventV2(
      {
        event_id: "antigravity:session-ag:step:1:gemini-4-hydrogen-high:usage",
        session_id: "session-ag",
        timestamp: "2026-11-25T10:00:00.000Z",
        source_vendor: "antigravity",
        source_adapter: "antigravity-acp",
        workspace_path: ".",
        type: "token.usage.recorded",
        message_id: "antigravity:session-ag:step:1:gemini-4-hydrogen-high",
        model: "gemini-4-hydrogen-high",
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4000,
        server_tool_use: "{}",
        usage_source: "antigravity-acp",
        provider_id: "google",
        first_token_latency_ms: null,
        decode_duration_ms: null
      },
      { sourceRecordId: "antigravity:session-ag:step:1:gemini-4-hydrogen-high:usage" }
    );
    const enriched = {
      ...initial,
      first_token_latency_ms: 2500,
      decode_duration_ms: 1000
    } as NormalizedEventV2;

    projectNormalizedEvents(db, [initial]);
    expect(projectNormalizedEvents(db, [enriched, initial]).map((r) => r.conflict)).toEqual([
      false,
      false
    ]);

    expect(db.prepare("SELECT count(*) AS count, sum(output_tokens) AS tokens FROM usage_events").get())
      .toEqual({ count: 1, tokens: 200 });
    expect(db.prepare("SELECT count(*) AS count FROM event_diagnostics").get()).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT first_token_latency_ms, decode_duration_ms, semantic_fingerprint FROM usage_events").get()
    ).toEqual({
      first_token_latency_ms: 2500,
      decode_duration_ms: 1000,
      semantic_fingerprint: semanticFingerprint(enriched)
    });
    expect(db.prepare("SELECT semantic_fingerprint FROM event_observations").get()).toEqual({
      semantic_fingerprint: semanticFingerprint(enriched)
    });

    const models = selectTokensByModel(db as unknown as MetricsDatabase);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      sourceVendor: "antigravity",
      model: "gemini-4-hydrogen-high",
      avgOutputTokensPerSecond: 200,
      avgFirstTokenLatencyMs: 2500,
      speedSampleCount: 1,
      ttftSampleCount: 1
    });

    // Token mismatches and conflicting non-null timings must still record IDENTITY_CONFLICT.
    for (const change of [
      { output_tokens: 201 },
      { first_token_latency_ms: 3000 },
      { decode_duration_ms: 1200 }
    ]) {
      expect(projectNormalizedEvents(db, [{ ...enriched, ...change } as NormalizedEventV2])[0].conflict).toBe(true);
    }
    expect(db.prepare("SELECT first_token_latency_ms, decode_duration_ms FROM usage_events").get()).toEqual({
      first_token_latency_ms: 2500,
      decode_duration_ms: 1000
    });

    db.close();
  });

  it("enriches the same CodeBuddy request with a measured zero, billing and then a cache hit", () => {
    const db = createDb();
    runDomainMigrations(db);
    const original = toNormalizedEventV2({
      event_id: "codebuddy-cli:session-1:usage:message-1",
      session_id: "session-1",
      timestamp: "2026-10-27T02:57:36.264Z",
      source_vendor: "workbuddy",
      source_adapter: "codebuddy-cli-log",
      workspace_path: ".",
      type: "token.usage.recorded",
      message_id: "message-1",
      model: "hy4-preview",
      input_tokens: 100,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: "{}",
      usage_source: "codebuddy-log"
    });
    const reportedMiss = { ...original, cache_read_reported: true, credit: 0.42 } as NormalizedEventV2;
    const reportedHit = { ...original, cache_read_input_tokens: 75 } as NormalizedEventV2;
    const readUsage = () =>
      db
        .prepare(
          "SELECT event_id, credit, displayed_input_tokens, cache_read_input_tokens, cache_read_reported FROM usage_events"
        )
        .all();

    projectNormalizedEvents(db, [original]);
    expect(readUsage()[0]).toMatchObject({ cache_read_reported: null, credit: null });
    expect(projectNormalizedEvents(db, [reportedMiss])[0].conflict).toBe(false);
    expect(readUsage()[0]).toMatchObject({ cache_read_reported: 1, credit: 0.42 });

    for (const replay of [reportedHit, reportedHit, original, reportedMiss]) {
      expect(projectNormalizedEvents(db, [replay])[0].conflict).toBe(false);
    }
    expect(readUsage()).toEqual([
      {
        event_id: original.event_id,
        credit: 0.42,
        displayed_input_tokens: 25,
        cache_read_input_tokens: 75,
        cache_read_reported: null
      }
    ]);
    db.close();
  });
});
