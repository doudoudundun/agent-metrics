import { describe, expect, it } from "vitest";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import {
  normalizeOpenCodeMessageRow,
  normalizeOpenCodeSessionRow,
  normalizeOpenCodeToolPartRow,
  type OpenCodeMessageRow,
  type OpenCodePartRow,
  type OpenCodeSessionRow
} from "./opencode.js";

describe("normalizeOpenCodeSessionRow", () => {
  it("maps session lifecycle rows into source-aware normalized events", () => {
    const row: OpenCodeSessionRow = {
      id: "ses_open_1",
      directory: "D:/projects/dev/agent-metrics",
      time_created: 1777355820000,
      time_updated: 1777355840000,
      time_archived: 1777355855000,
      model: null,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0
    };

    expect(normalizeOpenCodeSessionRow(row)).toEqual([
      expect.objectContaining({
        event_id: "opencode:session:ses_open_1:started",
        session_id: "ses_open_1",
        source_vendor: "opencode",
        source_adapter: "opencode-db",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "session.started"
      }),
      expect.objectContaining({
        event_id: "opencode:session:ses_open_1:ended",
        session_id: "ses_open_1",
        type: "session.ended",
        duration_ms: 35000
      })
    ]);
  });
});

describe("normalizeOpenCodeMessageRow", () => {
  it("maps user and assistant messages into prompt, response, and token events", () => {
    const userRow: OpenCodeMessageRow = {
      id: "msg_user_1",
      session_id: "ses_open_1",
      time_created: 1777355820355,
      time_updated: 1777355820355,
      data: JSON.stringify({
        role: "user",
        time: { created: 1777355820355 }
      })
    };
    const userParts: OpenCodePartRow[] = [
      {
        id: "prt_user_text",
        message_id: "msg_user_1",
        session_id: "ses_open_1",
        time_created: 1777355820355,
        time_updated: 1777355820355,
        data: JSON.stringify({
          type: "text",
          text: "PopupActivity这个文件能看到里面是什么吗？"
        })
      }
    ];
    const assistantRow: OpenCodeMessageRow = {
      id: "msg_assistant_1",
      session_id: "ses_open_1",
      time_created: 1777355829153,
      time_updated: 1777355842420,
      data: JSON.stringify({
        role: "assistant",
        time: {
          created: 1777355829153,
          completed: 1777355842420
        },
        providerID: "opencode",
        modelID: "hy3-preview-free",
        finish: "tool-calls",
        path: {
          root: "D:/projects/dev/agent-metrics"
        },
        tokens: {
          input: 27470,
          output: 207,
          reasoning: 0,
          cache: {
            read: 2048,
            write: 0
          }
        }
      })
    };
    const assistantParts: OpenCodePartRow[] = [
      {
        id: "prt_assistant_text",
        message_id: "msg_assistant_1",
        session_id: "ses_open_1",
        time_created: 1777355840641,
        time_updated: 1777355840641,
        data: JSON.stringify({
          type: "text",
          text: "找到了！"
        })
      }
    ];

    expect(normalizeOpenCodeMessageRow({
      row: userRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      partRows: userParts
    })).toEqual([
      expect.objectContaining({
        event_id: "opencode:message:msg_user_1:prompt",
        session_id: "ses_open_1",
        type: "prompt.submitted",
        prompt_id: "msg_user_1",
        prompt_chars: "PopupActivity这个文件能看到里面是什么吗？".length
      })
    ]);

    const assistantEvents = normalizeOpenCodeMessageRow({
      row: assistantRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: null,
      partRows: assistantParts
    });

    expect(assistantEvents).toEqual([
      expect.objectContaining({
        event_id: "opencode:message:msg_assistant_1:assistant",
        session_id: "ses_open_1",
        type: "assistant.responded",
        message_id: "msg_assistant_1",
        model: "hy3-preview-free",
        stop_reason: "tool-calls",
        response_chars: "找到了！".length,
        provider_id: "opencode"
      }),
      expect.objectContaining({
        event_id: "opencode:message:msg_assistant_1:usage",
        session_id: "ses_open_1",
        type: "token.usage.recorded",
        message_id: "msg_assistant_1",
        model: "hy3-preview-free",
        input_tokens: 27470,
        output_tokens: 207,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2048,
        usage_source: "opencode-message",
        provider_id: "opencode"
      })
    ]);

    for (const event of assistantEvents) {
      expect(AnyEventSchema.safeParse(event).success).toBe(true);
    }
  });
});

describe("normalizeOpenCodeToolPartRow", () => {
  it("maps tool parts into called and finished tool events", () => {
    const partRow: OpenCodePartRow = {
      id: "prt_tool_1",
      message_id: "msg_assistant_1",
      session_id: "ses_open_1",
      time_created: 1777355841227,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "tool",
        tool: "read",
        state: {
          status: "error",
          input: {
            filePath: "D:/projects/dev/agent-metrics/src/app.ts"
          },
          time: {
            start: 1777355841852,
            end: 1777355841866
          }
        }
      })
    };

    const events = normalizeOpenCodeToolPartRow({
      row: partRow,
      sessionDirectory: "D:/projects/dev/agent-metrics"
    });

    expect(events).toEqual([
      expect.objectContaining({
        event_id: "opencode:part:prt_tool_1:tool:started",
        session_id: "ses_open_1",
        type: "tool.called",
        tool_name: "read",
        status: "started"
      }),
      expect.objectContaining({
        event_id: "opencode:part:prt_tool_1:tool:failed",
        session_id: "ses_open_1",
        type: "tool.failed",
        tool_name: "read",
        status: "failed",
        duration_ms: 14
      })
    ]);

    for (const event of events) {
      expect(AnyEventSchema.safeParse(event).success).toBe(true);
    }
  });
});
