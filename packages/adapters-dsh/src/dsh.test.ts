import { describe, expect, it } from "vitest";
import { createDshParseState, normalizeDshLogRecord, normalizeDshSessionHeader } from "./dsh.js";

describe("normalizeDshSessionHeader", () => {
  it("emits a session.started event from the JSONL header", () => {
    const events = normalizeDshSessionHeader({
      id: "session-1",
      createdAt: 1_786_587_424_043,
      cwd: "D:/projects/dev/demo"
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "dsh:session-1:started",
        source_vendor: "dsh",
        source_adapter: "dsh-jsonl",
        type: "session.started",
        session_id: "session-1"
      })
    ]);
  });
});

describe("normalizeDshLogRecord", () => {
  it("maps human prompts, tools, and assistant usage", () => {
    const state = createDshParseState();
    const sessionId = "session-1";
    const workspacePath = "D:/projects/dev/demo";

    const prompt = normalizeDshLogRecord(
      {
        type: "user/message",
        seq: 0,
        time: 1_786_587_424_415,
        data: {
          id: "msg_user_1",
          role: "user",
          content: [{ type: "text", text: "hello dsh" }],
          source: { kind: "user" }
        }
      },
      sessionId,
      workspacePath,
      state
    );
    const pluginNotice = normalizeDshLogRecord(
      {
        type: "user/message",
        seq: 1,
        time: 1_786_587_424_500,
        data: {
          id: "msg_plugin_1",
          role: "user",
          content: [{ type: "text", text: "injected" }],
          source: { kind: "plugin", plugin: "dsh-plugin" }
        }
      },
      sessionId,
      workspacePath,
      state
    );
    const toolCall = normalizeDshLogRecord(
      {
        type: "tool/call",
        seq: 2,
        time: 1_786_587_704_534,
        data: {
          turn: 1,
          step: 1,
          callId: "call_1",
          name: "Read",
          arguments: "{\"path\":\"README.md\"}"
        }
      },
      sessionId,
      workspacePath,
      state
    );
    const toolResult = normalizeDshLogRecord(
      {
        type: "tool/result",
        seq: 3,
        time: 1_786_587_704_600,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "msg_tool_1",
            role: "user",
            content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "ok" }] }],
            source: { kind: "tool", callId: "call_1" }
          }
        }
      },
      sessionId,
      workspacePath,
      state
    );
    const assistant = normalizeDshLogRecord(
      {
        type: "assistant/message",
        seq: 4,
        time: 1_786_587_704_487,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "msg_asst_1",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { kind: "model", provider: "deepseek", model: "deepseek-chat" }
          },
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 2,
            cacheWriteTokens: 1
          }
        }
      },
      sessionId,
      workspacePath,
      state
    );

    expect(pluginNotice).toEqual([]);
    expect(prompt[0]).toEqual(
      expect.objectContaining({
        type: "prompt.submitted",
        source_vendor: "dsh",
        prompt_chars: 9
      })
    );
    expect(toolCall[0]).toEqual(
      expect.objectContaining({
        type: "tool.called",
        tool_name: "Read",
        source_adapter: "dsh-jsonl"
      })
    );
    expect(toolResult[0]).toEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "Read"
      })
    );
    expect(assistant[0]).toEqual(
      expect.objectContaining({
        type: "assistant.responded",
        model: "deepseek-chat",
        provider_id: "deepseek"
      })
    );
    expect(assistant[1]).toEqual(
      expect.objectContaining({
        type: "token.usage.recorded",
        usage_source: "dsh-usage",
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1
      })
    );
  });

  it("emits code.edit.applied for a successful edit tool result", () => {
    const state = createDshParseState();
    const sessionId = "session-1";
    const workspacePath = "D:/projects/dev/demo";

    normalizeDshLogRecord(
      {
        type: "tool/call",
        seq: 2,
        time: 1_786_587_704_534,
        data: {
          callId: "call_edit",
          name: "edit",
          arguments: JSON.stringify({
            file_path: "D:/projects/dev/demo/a.kt",
            old_string: "one\ntwo",
            new_string: "one\nTWO\nthree"
          })
        }
      },
      sessionId,
      workspacePath,
      state
    );
    const events = normalizeDshLogRecord(
      {
        type: "tool/result",
        seq: 3,
        time: 1_786_587_704_600,
        data: {
          message: {
            id: "msg_tool_1",
            role: "user",
            content: [{ type: "tool-result", toolCallId: "call_edit", content: [{ type: "text", text: "ok" }] }],
            source: { kind: "tool", callId: "call_edit" }
          }
        }
      },
      sessionId,
      workspacePath,
      state
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: "code.edit.applied",
        tool_name: "edit",
        files_changed: ["D:/projects/dev/demo/a.kt"],
        file_count: 1,
        insertions: 2,
        deletions: 1,
        edit_operation_count: 1
      })
    );
  });

  it("does not emit code.edit.applied when the edit tool fails", () => {
    const state = createDshParseState();
    const sessionId = "session-1";
    const workspacePath = "D:/projects/dev/demo";

    normalizeDshLogRecord(
      {
        type: "tool/call",
        seq: 2,
        time: 1_786_587_704_534,
        data: {
          callId: "call_fail",
          name: "edit",
          arguments: JSON.stringify({ file_path: "a.kt", old_string: "x", new_string: "y" })
        }
      },
      sessionId,
      workspacePath,
      state
    );
    const events = normalizeDshLogRecord(
      {
        type: "tool/result",
        seq: 3,
        time: 1_786_587_704_600,
        data: {
          message: {
            id: "msg_tool_1",
            role: "user",
            content: [{ type: "tool-result", toolCallId: "call_fail", isError: true, content: [] }],
            source: { kind: "tool", callId: "call_fail" }
          }
        }
      },
      sessionId,
      workspacePath,
      state
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ type: "tool.failed" }));
  });
});
