import { describe, expect, it } from "vitest";
import {
  createWorkbuddyParseState,
  normalizeWorkbuddyRecord,
  normalizeWorkbuddySessionHeader
} from "./workbuddy.js";

const SESSION_ID = "session-1";
const WORKSPACE = "D:/projects/dev/demo";

describe("normalizeWorkbuddySessionHeader", () => {
  it("emits a session.started event for a WorkBuddy transcript", () => {
    const events = normalizeWorkbuddySessionHeader({
      id: SESSION_ID,
      startedAt: 1_792_463_851_438,
      cwd: WORKSPACE
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: `workbuddy:${SESSION_ID}:started`,
        source_vendor: "workbuddy",
        source_adapter: "workbuddy-jsonl",
        type: "session.started",
        session_id: SESSION_ID
      })
    ]);
  });
});

describe("normalizeWorkbuddyRecord", () => {
  it("maps prompts, tool lifecycle, edits, assistant replies, and usage", () => {
    const state = createWorkbuddyParseState();

    const prompt = normalizeWorkbuddyRecord(
      {
        id: "msg_user_1",
        timestamp: 1_792_463_851_462,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello workbuddy" }],
        cwd: WORKSPACE
      },
      SESSION_ID,
      WORKSPACE,
      state
    );

    const toolCall = normalizeWorkbuddyRecord(
      {
        id: "rec_call_1",
        timestamp: 1_792_463_858_468,
        type: "function_call",
        callId: "call_1",
        name: "Edit",
        arguments: JSON.stringify({
          file_path: "src/app.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;\nconst b = 3;"
        }),
        providerData: { model: "deepseek-v4.1-flash", messageId: "asst_msg_1", stepSeq: 1 }
      },
      SESSION_ID,
      WORKSPACE,
      state
    );

    const toolResult = normalizeWorkbuddyRecord(
      {
        id: "rec_result_1",
        timestamp: 1_792_463_859_468,
        type: "function_call_result",
        name: "Edit",
        callId: "call_1",
        status: "completed",
        output: { type: "text", text: "ok" }
      },
      SESSION_ID,
      WORKSPACE,
      state
    );

    const assistant = normalizeWorkbuddyRecord(
      {
        id: "asst_msg_2",
        timestamp: 1_792_463_891_326,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
        providerData: {
          model: "deepseek-v4.1-flash",
          messageId: "asst_msg_2",
          usage: {
            requests: 1,
            inputTokens: 1000,
            outputTokens: 50,
            totalTokens: 1050,
            inputTokensDetails: [{ cached_tokens: 800 }]
          },
          rawUsage: {
            prompt_tokens: 1000,
            completion_tokens: 50,
            prompt_cache_hit_tokens: 800,
            prompt_cache_write_tokens: 0
          }
        }
      },
      SESSION_ID,
      WORKSPACE,
      state
    );

    const repeatedUsage = normalizeWorkbuddyRecord(
      {
        id: "asst_msg_2_duplicate",
        timestamp: 1_792_463_891_400,
        type: "function_call",
        callId: "call_2",
        name: "Read",
        arguments: JSON.stringify({ file_path: "README.md" }),
        providerData: {
          model: "deepseek-v4.1-flash",
          messageId: "asst_msg_2",
          usage: { requests: 1, inputTokens: 1000, outputTokens: 50 }
        }
      },
      SESSION_ID,
      WORKSPACE,
      state
    );

    expect(prompt.map((event) => event.type)).toEqual(["prompt.submitted"]);
    expect(toolCall.map((event) => event.type)).toEqual(["tool.called"]);
    expect(toolResult.map((event) => event.type)).toEqual(["tool.succeeded", "code.edit.applied"]);
    expect(toolResult[1]).toEqual(
      expect.objectContaining({
        tool_name: "Edit",
        files_changed: ["src/app.ts"],
        file_count: 1,
        insertions: 2,
        deletions: 1,
        edit_operation_count: 1
      })
    );
    expect(assistant.map((event) => event.type)).toEqual(["assistant.responded", "token.usage.recorded"]);
    expect(assistant[1]).toEqual(
      expect.objectContaining({
        usage_source: "workbuddy-usage",
        model: "deepseek-v4.1-flash",
        input_tokens: 1000,
        output_tokens: 50,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 0,
        input_token_semantics: "gross"
      })
    );
    // The same step-level usage is never counted twice.
    expect(repeatedUsage.map((event) => event.type)).toEqual(["tool.called"]);

    for (const event of [...prompt, ...toolCall, ...toolResult, ...assistant]) {
      expect(event.source_vendor).toBe("workbuddy");
      expect(event.source_adapter).toBe("workbuddy-jsonl");
      expect(event.source_instance_id).toBe("workbuddy:default");
    }
  });

  it("marks non-completed tool results as failures and ignores bookkeeping rows", () => {
    const state = createWorkbuddyParseState();
    normalizeWorkbuddyRecord(
      {
        id: "rec_call_1",
        timestamp: 1_792_463_858_468,
        type: "function_call",
        callId: "call_1",
        name: "Bash",
        arguments: "{\"command\":\"exit 1\"}"
      },
      SESSION_ID,
      WORKSPACE,
      state
    );

    const failed = normalizeWorkbuddyRecord(
      {
        id: "rec_result_1",
        timestamp: 1_792_463_858_968,
        type: "function_call_result",
        name: "Bash",
        callId: "call_1",
        status: "error",
        output: { type: "text", text: "boom" }
      },
      SESSION_ID,
      WORKSPACE,
      state
    );

    expect(failed.map((event) => event.type)).toEqual(["tool.failed"]);
    expect(failed[0]).toEqual(expect.objectContaining({ tool_name: "Bash", duration_ms: 500 }));

    expect(
      normalizeWorkbuddyRecord(
        { id: "meta_1", timestamp: 1_792_463_851_400, type: "session-meta", meta: {} },
        SESSION_ID,
        WORKSPACE,
        state
      )
    ).toEqual([]);
    expect(
      normalizeWorkbuddyRecord(
        { id: "title_1", timestamp: 1_792_463_851_400, type: "ai-title", aiTitle: "demo" },
        SESSION_ID,
        WORKSPACE,
        state
      )
    ).toEqual([]);
  });
});
