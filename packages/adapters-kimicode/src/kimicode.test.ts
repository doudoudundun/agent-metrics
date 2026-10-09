import { describe, expect, it } from "vitest";
import {
  createKimicodeWireParseState,
  normalizeKimicodeSessionState,
  normalizeKimicodeWireRecord
} from "./kimicode.js";

describe("normalizeKimicodeSessionState", () => {
  it("emits a session.started event from state.json", () => {
    const events = normalizeKimicodeSessionState({
      state: {
        id: "session_1",
        cwd: "D:/projects/dev/demo",
        createdAt: 1_786_587_424_043
      }
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "kimicode:session:session_1:started",
        source_vendor: "kimicode",
        source_adapter: "kimicode-wire",
        type: "session.started",
        session_id: "session_1"
      })
    ]);
  });
});

describe("normalizeKimicodeWireRecord", () => {
  it("maps turn prompts, tools, and turn-scoped usage", () => {
    const state = createKimicodeWireParseState();
    const context = {
      sessionId: "session_1",
      workspacePath: "D:/projects/dev/demo",
      agentId: "main"
    };

    const prompt = normalizeKimicodeWireRecord(
      {
        type: "turn.prompt",
        input: [{ type: "text", text: "hello" }],
        time: 1_786_587_424_415
      },
      context,
      state
    );
    const request = normalizeKimicodeWireRecord(
      {
        type: "llm.request",
        provider: "openai",
        modelAlias: "kimi-code/k3-256k",
        time: 1_786_587_424_443
      },
      context,
      state
    );
    const toolCall = normalizeKimicodeWireRecord(
      {
        type: "context.append_loop_event",
        event: {
          type: "tool.call",
          toolCallId: "call_1",
          name: "Read",
          args: { path: "README.md" }
        },
        time: 1_786_587_704_534
      },
      context,
      state
    );
    const usage = normalizeKimicodeWireRecord(
      {
        type: "usage.record",
        model: "kimi-code/k3-256k",
        usage: {
          inputOther: 13308,
          output: 86,
          inputCacheRead: 15808,
          inputCacheCreation: 0
        },
        usageScope: "turn",
        time: 1_786_587_704_487
      },
      context,
      state
    );

    expect(request).toEqual([]);
    expect(prompt[0]).toEqual(
      expect.objectContaining({
        type: "prompt.submitted",
        source_vendor: "kimicode",
        prompt_chars: 5
      })
    );
    expect(toolCall[0]).toEqual(
      expect.objectContaining({
        type: "tool.called",
        tool_name: "Read",
        source_adapter: "kimicode-wire"
      })
    );
    expect(usage[0]).toEqual(
      expect.objectContaining({
        type: "token.usage.recorded",
        usage_source: "kimicode-usage",
        input_tokens: 13308,
        output_tokens: 86,
        cache_read_input_tokens: 15808,
        provider_id: "kimi-code"
      })
    );
  });
});
