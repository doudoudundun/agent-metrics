import { describe, expect, it } from "vitest";
import { NormalizedEventV2Schema } from "@agent-metrics/event-schema";
import {
  normalizeOpenCodePartRow,
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
        source_record_id: "opencode:session:ses_open_1:started",
        session_id: "ses_open_1",
        source_vendor: "opencode",
        source_adapter: "opencode-db",
        workspace_path: "D:/projects/dev/agent-metrics",
        type: "session.started"
      }),
      expect.objectContaining({
        source_record_id: "opencode:session:ses_open_1:ended",
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
        source_record_id: "opencode:message:msg_user_1:prompt",
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
        source_record_id: "opencode:message:msg_assistant_1:assistant",
        session_id: "ses_open_1",
        type: "assistant.responded",
        message_id: "msg_assistant_1",
        model: "hy3-preview-free",
        stop_reason: "tool-calls",
        response_chars: "找到了！".length,
        provider_id: "opencode"
      }),
      expect.objectContaining({
        source_record_id: "opencode:message:msg_assistant_1:usage",
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
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("folds Anthropic-style cache-read into gross input when cache exceeds input", () => {
    const assistantRow: OpenCodeMessageRow = {
      id: "msg_assistant_net_cache",
      session_id: "ses_open_net_cache",
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
        finish: "stop",
        path: {
          root: "D:/projects/dev/agent-metrics"
        },
        tokens: {
          input: 437,
          output: 47,
          reasoning: 0,
          cache: {
            read: 45568,
            write: 0
          }
        }
      })
    };

    const events = normalizeOpenCodeMessageRow({
      row: assistantRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      partRows: []
    });
    const usage = events.find((event) => event.type === "token.usage.recorded");

    expect(usage).toEqual(
      expect.objectContaining({
        type: "token.usage.recorded",
        input_tokens: 46005,
        output_tokens: 47,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 45568,
        usage_source: "opencode-message"
      })
    );
    expect(NormalizedEventV2Schema.safeParse(usage).success).toBe(true);
  });

  it("enriches assistant and usage events from a provider registry", () => {
    const assistantRow: OpenCodeMessageRow = {
      id: "msg_assistant_registry",
      session_id: "ses_open_registry",
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
        finish: "stop",
        tokens: {
          input: 10,
          output: 4,
          reasoning: 1,
          cache: {
            read: 2,
            write: 3
          }
        }
      })
    };
    const assistantParts: OpenCodePartRow[] = [
      {
        id: "prt_assistant_registry_text",
        message_id: "msg_assistant_registry",
        session_id: "ses_open_registry",
        time_created: 1777355840641,
        time_updated: 1777355840641,
        data: JSON.stringify({
          type: "text",
          text: "Done."
        })
      }
    ];

    const events = normalizeOpenCodeMessageRow({
      row: assistantRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: null,
      partRows: assistantParts,
      providerRegistry: {
        opencode: {
          baseUrl: "https://opencode.ai/zen/v1",
          host: "opencode.ai"
        }
      }
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "opencode:message:msg_assistant_registry:assistant",
        provider_id: "opencode",
        provider_base_url: "https://opencode.ai/zen/v1",
        provider_host: "opencode.ai"
      }),
      expect.objectContaining({
        source_record_id: "opencode:message:msg_assistant_registry:usage",
        provider_id: "opencode",
        provider_base_url: "https://opencode.ai/zen/v1",
        provider_host: "opencode.ai"
      })
    ]);
  });

  it("suppresses message-level usage when a step-finish part already carries tokens", () => {
    const assistantRow: OpenCodeMessageRow = {
      id: "msg_assistant_step_finish",
      session_id: "ses_open_step_finish",
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
        finish: "stop",
        tokens: {
          input: 220,
          output: 84,
          reasoning: 12,
          cache: {
            read: 5,
            write: 0
          }
        }
      })
    };
    const assistantParts: OpenCodePartRow[] = [
      {
        id: "prt_assistant_step_finish_text",
        message_id: "msg_assistant_step_finish",
        session_id: "ses_open_step_finish",
        time_created: 1777355840641,
        time_updated: 1777355840641,
        data: JSON.stringify({
          type: "text",
          text: "Done."
        })
      },
      {
        id: "prt_assistant_step_finish_usage",
        message_id: "msg_assistant_step_finish",
        session_id: "ses_open_step_finish",
        time_created: 1777355842000,
        time_updated: 1777355842100,
        data: JSON.stringify({
          type: "step-finish",
          tokens: {
            input: 220,
            output: 84,
            reasoning: 12,
            cache: {
              read: 5,
              write: 0
            }
          }
        })
      }
    ];

    const events = normalizeOpenCodeMessageRow({
      row: assistantRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: null,
      partRows: assistantParts
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "opencode:message:msg_assistant_step_finish:assistant",
        type: "assistant.responded"
      })
    ]);
  });

  it("does not emit message-level usage for zero-token placeholders", () => {
    const assistantRow: OpenCodeMessageRow = {
      id: "msg_assistant_zero_tokens",
      session_id: "ses_open_zero_tokens",
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
        finish: "stop",
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0
          }
        }
      })
    };

    const events = normalizeOpenCodeMessageRow({
      row: assistantRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: null,
      partRows: []
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "opencode:message:msg_assistant_zero_tokens:assistant",
        type: "assistant.responded"
      })
    ]);
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
        source_record_id: "opencode:part:prt_tool_1:tool:started",
        session_id: "ses_open_1",
        type: "tool.called",
        tool_name: "read",
        status: "started",
        tool_call_id: "native:prt_tool_1"
      }),
      expect.objectContaining({
        source_record_id: "opencode:part:prt_tool_1:tool:failed",
        session_id: "ses_open_1",
        type: "tool.failed",
        tool_name: "read",
        status: "failed",
        tool_call_id: "native:prt_tool_1",
        duration_ms: 14
      })
    ]);

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("emits code.edit.applied with filediff counts for a completed edit", () => {
    const partRow: OpenCodePartRow = {
      id: "prt_edit_1",
      message_id: "msg_assistant_1",
      session_id: "ses_open_1",
      time_created: 1777355841227,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "D:/projects/dev/demo/a.ts",
            oldString: "one\ntwo",
            newString: "one\nTWO\nthree"
          },
          metadata: {
            filediff: { file: "D:/projects/dev/demo/a.ts", additions: 2, deletions: 1 }
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
      sessionDirectory: "D:/projects/dev/demo"
    });

    expect(events).toHaveLength(3);
    expect(events[2]).toEqual(
      expect.objectContaining({
        type: "code.edit.applied",
        tool_name: "edit",
        files_changed: ["D:/projects/dev/demo/a.ts"],
        file_count: 1,
        insertions: 2,
        deletions: 1,
        edit_operation_count: 1
      })
    );
    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("falls back to diffing old/new strings when no diff metadata exists", () => {
    const partRow: OpenCodePartRow = {
      id: "prt_edit_2",
      message_id: "msg_assistant_1",
      session_id: "ses_open_1",
      time_created: 1777355841227,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "tool",
        tool: "Edit",
        state: {
          status: "completed",
          input: {
            file_path: "D:/projects/dev/demo/b.ts",
            old_string: "alpha\nbeta",
            new_string: "alpha\nBETA\ngamma"
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
      sessionDirectory: "D:/projects/dev/demo"
    });

    const edit = events.find((event) => event.type === "code.edit.applied");
    expect(edit).toEqual(
      expect.objectContaining({
        files_changed: ["D:/projects/dev/demo/b.ts"],
        insertions: 2,
        deletions: 1
      })
    );
  });

  it("counts only insertions for a completed write", () => {
    const partRow: OpenCodePartRow = {
      id: "prt_write_1",
      message_id: "msg_assistant_1",
      session_id: "ses_open_1",
      time_created: 1777355841227,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "tool",
        tool: "Write",
        state: {
          status: "completed",
          input: {
            file_path: "D:/projects/dev/demo/c.ts",
            content: "alpha\nbeta\n"
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
      sessionDirectory: "D:/projects/dev/demo"
    });

    const edit = events.find((event) => event.type === "code.edit.applied");
    expect(edit).toEqual(
      expect.objectContaining({
        tool_name: "Write",
        insertions: 2,
        deletions: 0,
        edit_operation_count: 1
      })
    );
  });

  it("does not emit code.edit.applied for a failed edit", () => {
    const partRow: OpenCodePartRow = {
      id: "prt_edit_fail",
      message_id: "msg_assistant_1",
      session_id: "ses_open_1",
      time_created: 1777355841227,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "tool",
        tool: "edit",
        state: {
          status: "error",
          input: {
            filePath: "D:/projects/dev/demo/a.ts",
            oldString: "x",
            newString: "y"
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
      sessionDirectory: "D:/projects/dev/demo"
    });

    expect(events.some((event) => event.type === "code.edit.applied")).toBe(false);
  });

  it("maps step-finish parts into token usage events with provider metadata", () => {
    const messageRow: OpenCodeMessageRow = {
      id: "msg_assistant_usage_part",
      session_id: "ses_open_usage_part",
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
        path: {
          root: "D:/projects/dev/agent-metrics"
        }
      })
    };
    const partRow: OpenCodePartRow = {
      id: "prt_step_finish_usage",
      message_id: "msg_assistant_usage_part",
      session_id: "ses_open_usage_part",
      time_created: 1777355841852,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "step-finish",
        tokens: {
          input: 220,
          output: 84,
          reasoning: 12,
          cache: {
            read: 5,
            write: 0
          }
        }
      })
    };

    const events = normalizeOpenCodePartRow({
      row: partRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: "hy3-preview-free",
      messageRow,
      providerRegistry: {
        opencode: {
          baseUrl: "https://opencode.ai/zen/v1",
          host: "opencode.ai"
        }
      }
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "opencode:message:msg_assistant_usage_part:usage",
        session_id: "ses_open_usage_part",
        type: "token.usage.recorded",
        model: "hy3-preview-free",
        input_tokens: 220,
        output_tokens: 96,
        cache_read_input_tokens: 5,
        usage_source: "opencode-step-finish",
        provider_id: "opencode",
        provider_base_url: "https://opencode.ai/zen/v1",
        provider_host: "opencode.ai"
      })
    ]);

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("prefers model_usage timing over the message-level duration estimate", () => {
    const messageRow: OpenCodeMessageRow = {
      id: "msg_assistant_timing",
      session_id: "ses_timing",
      time_created: 1777355829153,
      time_updated: 1777355842420,
      data: JSON.stringify({
        role: "assistant",
        time: { created: 1777355829153, completed: 1777355842420 },
        modelID: "glm-5.3"
      })
    };
    const partRow: OpenCodePartRow = {
      id: "prt_step_timing",
      message_id: "msg_assistant_timing",
      session_id: "ses_timing",
      time_created: 1777355841852,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "step-finish",
        tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }
      })
    };

    const precise = normalizeOpenCodePartRow({
      row: partRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: "glm-5.3",
      messageRow,
      modelUsage: { timeToFirstTokenMs: 1500, durationMs: 8000 }
    });
    expect(precise[0]).toEqual(
      expect.objectContaining({
        type: "token.usage.recorded",
        first_token_latency_ms: 1500,
        decode_duration_ms: 6500
      })
    );

    // Without model_usage, fall back to the message created→completed window.
    const fallback = normalizeOpenCodePartRow({
      row: partRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: "glm-5.3",
      messageRow
    });
    expect(fallback[0]).toEqual(
      expect.objectContaining({
        type: "token.usage.recorded",
        first_token_latency_ms: null,
        decode_duration_ms: 1777355842420 - 1777355829153
      })
    );
  });

  it("folds Anthropic-style step-finish cache-read into gross input", () => {
    const messageRow: OpenCodeMessageRow = {
      id: "msg_assistant_net_step",
      session_id: "ses_open_net_step",
      time_created: 1777355829153,
      time_updated: 1777355842420,
      data: JSON.stringify({
        role: "assistant",
        providerID: "opencode",
        modelID: "hy3-preview-free"
      })
    };
    const partRow: OpenCodePartRow = {
      id: "prt_assistant_net_step",
      message_id: "msg_assistant_net_step",
      session_id: "ses_open_net_step",
      time_created: 1777355841852,
      time_updated: 1777355841866,
      data: JSON.stringify({
        type: "step-finish",
        tokens: {
          input: 87,
          output: 79,
          reasoning: 0,
          cache: {
            read: 56704,
            write: 0
          }
        }
      })
    };

    const events = normalizeOpenCodePartRow({
      row: partRow,
      sessionDirectory: "D:/projects/dev/agent-metrics",
      sessionModel: "hy3-preview-free",
      messageRow
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "token.usage.recorded",
        input_tokens: 56791,
        output_tokens: 79,
        cache_read_input_tokens: 56704,
        usage_source: "opencode-step-finish"
      })
    ]);
    expect(NormalizedEventV2Schema.safeParse(events[0]).success).toBe(true);
  });

  it("supports zcode event namespacing and adapter tagging", () => {
    const messageRow: OpenCodeMessageRow = {
      id: "msg_zcode_usage",
      session_id: "sess_zcode_1",
      time_created: 1777355829153,
      time_updated: 1777355842420,
      data: JSON.stringify({
        role: "assistant",
        time: {
          created: 1777355829153,
          completed: 1777355842420
        },
        providerID: "builtin:zai-coding-plan",
        modelID: "GLM-5-Turbo",
        finish: "tool-calls",
        path: {
          root: "C:/Users/qinyang.li/ZCodeProject"
        },
        tokens: {
          input: 220,
          output: 84,
          reasoning: 12,
          cache: {
            read: 5,
            write: 0
          }
        }
      })
    };

    const events = normalizeOpenCodeMessageRow({
      row: messageRow,
      sessionDirectory: "C:/Users/qinyang.li/ZCodeProject",
      partRows: [],
      eventContext: {
        eventNamespace: "zcode",
        sourceAdapter: "zcode-db",
        sourceVendor: "zcode"
      }
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "opencode:zcode:message:msg_zcode_usage:assistant",
        source_vendor: "zcode",
        source_adapter: "zcode-db"
      }),
      expect.objectContaining({
        source_record_id: "opencode:zcode:message:msg_zcode_usage:usage",
        source_vendor: "zcode",
        source_adapter: "zcode-db",
        usage_source: "opencode-message"
      })
    ]);
  });

  it("reads ZCode lower-camel modelId/providerId when modelID/providerID are absent", () => {
    const messageRow: OpenCodeMessageRow = {
      id: "msg_zcode_camel",
      session_id: "ses_zcode_camel",
      time_created: 1777355829153,
      time_updated: 1777355842420,
      data: JSON.stringify({
        role: "assistant",
        time: {
          created: 1777355829153,
          completed: 1777355842420
        },
        modelId: "GLM-5.3-Flash",
        providerId: "account:bigmodel-individual-coding-plan",
        finish: "stop",
        path: {
          root: "C:/Users/qinyang.li/ZCodeProject"
        },
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: {
            read: 5,
            write: 0
          }
        }
      })
    };

    const events = normalizeOpenCodeMessageRow({
      row: messageRow,
      sessionDirectory: "C:/Users/qinyang.li/ZCodeProject",
      partRows: [],
      eventContext: {
        eventNamespace: "zcode",
        sourceAdapter: "zcode-db",
        sourceVendor: "zcode"
      }
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "assistant.responded",
        model: "GLM-5.3-Flash",
        provider_id: "account:bigmodel-individual-coding-plan"
      }),
      expect.objectContaining({
        type: "token.usage.recorded",
        model: "GLM-5.3-Flash"
      })
    ]);
  });
});
