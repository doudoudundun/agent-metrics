import { describe, expect, it } from "vitest";
import {
  normalizeAntigravitySessionStarted,
  normalizeAntigravityTranscriptRecord
} from "./antigravity.js";

const SESSION_ID = "5ceda8df-b8d7-4283-b119-7b8214581eb0";
const CONTEXT = { sessionId: SESSION_ID };

function userInput(overrides: Record<string, unknown> = {}) {
  return {
    step_index: 0,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-11-23T14:49:14Z",
    content: "hello antigravity",
    ...overrides
  };
}

function plannerResponse(overrides: Record<string, unknown> = {}) {
  return {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-23T14:49:40Z",
    model: "gemini-pro-orchestrator-neon",
    input_tokens: 3573,
    cache_read_tokens: 33090,
    output_tokens: 353,
    thinking: "let me think about this at length",
    content: "answer",
    tool_calls: [{ name: "read_file" }],
    ...overrides
  };
}

describe("normalizeAntigravityTranscriptRecord", () => {
  it("maps a USER_INPUT row to a prompt.submitted event storing only the character count", () => {
    const events = normalizeAntigravityTranscriptRecord(userInput(), CONTEXT);

    expect(events).toHaveLength(1);
    const prompt = events[0];
    expect(prompt.type).toBe("prompt.submitted");
    expect(prompt.session_id).toBe(SESSION_ID);
    expect(prompt.workspace_path).toBe(".");
    expect(prompt.source_vendor).toBe("antigravity");
    expect(prompt.source_adapter).toBe("antigravity-acp");
    expect(prompt).toMatchObject({ prompt_chars: 17 });
    expect(JSON.stringify(prompt)).not.toContain("hello antigravity");
  });

  it("skips USER_INPUT rows without a step index or timestamp", () => {
    expect(normalizeAntigravityTranscriptRecord(userInput({ step_index: undefined }), CONTEXT)).toEqual([]);
    expect(normalizeAntigravityTranscriptRecord(userInput({ created_at: "" }), CONTEXT)).toEqual([]);
    expect(normalizeAntigravityTranscriptRecord(userInput({ created_at: "not-a-date" }), CONTEXT)).toEqual([]);
  });

  it("maps a PLANNER_RESPONSE row to assistant.responded plus token.usage.recorded with cache-read above input", () => {
    const events = normalizeAntigravityTranscriptRecord(plannerResponse(), CONTEXT);

    expect(events.map((event) => event.type)).toEqual([
      "assistant.responded",
      "token.usage.recorded"
    ]);
    const [assistant, usage] = events;

    expect(assistant).toMatchObject({
      session_id: SESSION_ID,
      workspace_path: ".",
      model: "gemini-pro-orchestrator-neon",
      response_chars: 6,
      provider_id: "google"
    });
    // thinking text must not leak into the response size or the payload
    expect(JSON.stringify(assistant)).not.toContain("let me think");

    expect(usage).toMatchObject({
      input_tokens: 3573,
      cache_read_input_tokens: 33090,
      cache_creation_input_tokens: 0,
      output_tokens: 353,
      usage_source: "antigravity-acp",
      input_token_semantics: "delta",
      usage_measurement: "increment",
      provider_id: "google",
      first_token_latency_ms: null,
      decode_duration_ms: null
    });
  });

  it("counts no response characters when the planner row has no content", () => {
    const events = normalizeAntigravityTranscriptRecord(
      plannerResponse({ content: undefined }),
      CONTEXT
    );
    expect(events[0]).toMatchObject({ response_chars: 0 });
  });

  it("keeps stable ids scoped to session, step, and model across planner variants", () => {
    const orchestrator = normalizeAntigravityTranscriptRecord(plannerResponse(), CONTEXT);
    const worker = normalizeAntigravityTranscriptRecord(
      plannerResponse({ step_index: 3, model: "gemini-flash-worker-agy" }),
      CONTEXT
    );

    for (const events of [orchestrator, worker]) {
      for (const event of events) {
        expect(event.event_id.startsWith("v2:antigravity:default:antigravity-acp:")).toBe(true);
        expect(event.source_record_id?.startsWith("antigravity:")).toBe(true);
        expect(event.source_record_id).not.toBe(event.event_id);
      }
    }

    expect(orchestrator[0].message_id).toBe(`antigravity:${SESSION_ID}:step:1:gemini-pro-orchestrator-neon`);
    expect(worker[0].message_id).toBe(`antigravity:${SESSION_ID}:step:3:gemini-flash-worker-agy`);
    expect(new Set([...orchestrator, ...worker].map((event) => event.event_id)).size).toBe(4);
  });

  it("emits no usage event when every token counter is missing or zero", () => {
    const events = normalizeAntigravityTranscriptRecord(
      plannerResponse({ input_tokens: undefined, cache_read_tokens: 0, output_tokens: 0 }),
      CONTEXT
    );
    expect(events.map((event) => event.type)).toEqual(["assistant.responded"]);
  });

  it("defaults missing token counters to zero but keeps usage when any token is present", () => {
    const events = normalizeAntigravityTranscriptRecord(
      plannerResponse({ input_tokens: undefined, cache_read_tokens: undefined, output_tokens: 12 }),
      CONTEXT
    );
    expect(events[1]).toMatchObject({ input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 12 });
  });

  it("skips PLANNER_RESPONSE rows without model, step index, or timestamp", () => {
    expect(normalizeAntigravityTranscriptRecord(plannerResponse({ model: undefined }), CONTEXT)).toEqual([]);
    expect(normalizeAntigravityTranscriptRecord(plannerResponse({ step_index: undefined }), CONTEXT)).toEqual([]);
    expect(normalizeAntigravityTranscriptRecord(plannerResponse({ created_at: undefined }), CONTEXT)).toEqual([]);
  });

  it("maps model families to provider ids", () => {
    const cases: Array<[string, string]> = [
      ["gemini-4-argon-high", "google"],
      ["claude-opus-4.6", "anthropic"],
      ["gpt-5.4-codex", "openai"],
      ["qwen3-max", "unknown"]
    ];
    for (const [model, providerId] of cases) {
      const events = normalizeAntigravityTranscriptRecord(plannerResponse({ model }), CONTEXT);
      expect(events[0]).toMatchObject({ provider_id: providerId });
      expect(events[1]).toMatchObject({ provider_id: providerId });
    }
  });

  it("ignores non-transcript row types and malformed records", () => {
    for (const record of [
      null,
      42,
      "text",
      { type: "GENERIC", step_index: 9, created_at: "2026-11-23T14:49:14Z" },
      { type: "SYSTEM_MESSAGE", step_index: 9, created_at: "2026-11-23T14:49:14Z" },
      { type: "CHECKPOINT", step_index: 9, created_at: "2026-11-23T14:49:14Z" },
      { step_index: 9, created_at: "2026-11-23T14:49:14Z" }
    ]) {
      expect(normalizeAntigravityTranscriptRecord(record, CONTEXT)).toEqual([]);
    }
  });
});

describe("normalizeAntigravitySessionStarted", () => {
  it("emits a session.started event keyed on the brain UUID", () => {
    const event = normalizeAntigravitySessionStarted({
      sessionId: SESSION_ID,
      timestamp: "2026-11-23T14:49:14Z"
    });

    expect(event.type).toBe("session.started");
    expect(event.session_id).toBe(SESSION_ID);
    expect(event.timestamp).toBe("2026-11-23T14:49:14.000Z");
    expect(event.event_id.startsWith("v2:antigravity:default:antigravity-acp:session.started:")).toBe(true);
    expect(event.source_record_id).toBe(`antigravity:${SESSION_ID}:session:started`);
    expect(event.source_vendor).toBe("antigravity");
    expect(event.source_adapter).toBe("antigravity-acp");
    expect(event.workspace_path).toBe(".");
  });
});
