import { describe, expect, it } from "vitest";
import { NormalizedEventV2Schema } from "@agent-metrics/event-schema";
import { extractCodexEventsFromRollout } from "./codex.js";

describe("extractCodexEventsFromRollout", () => {
  it("maps legacy custom_tool_call rows into normalized tool events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-legacy.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_legacy",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            status: "completed",
            call_id: "call_apply_patch_1",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch\n"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:06.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_apply_patch_1",
            output: JSON.stringify({
              output: "Success. Updated the following files:\nM src/app.ts\n",
              metadata: {
                exit_code: 0,
                duration_seconds: 0.4
              }
            })
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.called",
        tool_name: "apply_patch",
        status: "started",
        tool_call_id: "native:call_apply_patch_1"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "apply_patch",
        status: "succeeded",
        tool_call_id: "native:call_apply_patch_1",
        duration_ms: 400
      })
    );
  });

  it("maps patch_apply_end and web_search_end into tool and edit events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-new.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_new",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:10.000Z",
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "call_patch_1",
            success: true,
            stdout: "Success. Updated the following files:\nM src/app.ts\n",
            stderr: "",
            changes: {
              "D:/projects/dev/src/app.ts": {
                type: "update",
                unified_diff:
                  "@@ -1,2 +1,3 @@\n import x\n+const y = 1;\n-old\n+new\n"
              },
              "D:/projects/dev/src/new.ts": {
                type: "add",
                content: "first line\nsecond line\n"
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:11.000Z",
          type: "event_msg",
          payload: {
            type: "web_search_end",
            call_id: "call_web_1",
            query: "codex rollout patch_apply_end",
            action: {
              type: "search"
            }
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "apply_patch",
        status: "succeeded"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "code.edit.applied",
        tool_name: "apply_patch",
        files_changed: ["D:/projects/dev/src/app.ts", "D:/projects/dev/src/new.ts"],
        file_count: 2,
        insertions: 4,
        deletions: 1,
        edit_operation_count: 1
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "WebSearch",
        status: "succeeded"
      })
    );

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("maps item_completed FileChange items into edit events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/09/30/rollout-filechange.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-09-30T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_filechange",
            timestamp: "2026-09-30T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-09-30T10:00:10.000Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "FileChange",
              id: "exec-93d7c6d3",
              status: "completed",
              changes: {
                "D:/projects/dev/src/app.ts": {
                  type: "update",
                  unified_diff: "@@ -1,2 +1,3 @@\n import x\n+const y = 1;\n-old\n+new\n"
                }
              },
              stdout: "Success. Updated the following files:\nM src/app.ts\n",
              stderr: ""
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-09-30T10:00:11.000Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: {
              type: "FileChange",
              id: "exec-failed",
              status: "failed",
              changes: {
                "D:/projects/dev/src/other.ts": {
                  type: "update",
                  unified_diff: "@@ -1 +1 @@\n-a\n+b\n"
                }
              }
            }
          }
        })
      ].join("\n")
    });

    const edits = events.filter((event) => event.type === "code.edit.applied");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual(
      expect.objectContaining({
        tool_name: "apply_patch",
        files_changed: ["D:/projects/dev/src/app.ts"],
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

  it("maps exec_command_end into normalized shell tool events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-shell.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_shell",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "call_shell_1",
            command: [
              "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
              "-Command",
              "git diff --stat"
            ],
            cwd: "D:/projects/dev",
            stdout: "",
            stderr: "",
            exit_code: 0,
            duration: {
              secs: 2,
              nanos: 284934500
            },
            status: "completed"
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "git",
        status: "succeeded",
        duration_ms: 2285
      })
    );

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("maps shell_command function calls into normalized tool events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-shell-function.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_shell_fn",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_shell_fn_1",
            name: "shell_command",
            arguments: JSON.stringify({
              command: "rg -n \"exec_command_end\" C:/Users/test/.codex/sessions -S",
              workdir: "D:/projects/dev",
              timeout_ms: 20000
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_shell_fn_1",
            output: [
              "Exit code: 0",
              "Wall time: 2.3 seconds",
              "Output:",
              "C:/Users/test/.codex/sessions/rollout.jsonl:1:{...}"
            ].join("\n")
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "rg",
        status: "succeeded",
        duration_ms: 2300
      })
    );

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("treats custom_tool_call_output array parts and missing exit codes as success", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-custom-array.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_custom_array",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "call_custom_array_1",
            name: "exec",
            input: JSON.stringify({ cmd: "rg pattern src" })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:12.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_custom_array_1",
            output: [
              {
                type: "input_text",
                text: "Script completed\nWall time 9.0 seconds\nOutput:\n"
              },
              {
                type: "input_text",
                text: "src/index.ts:1:match"
              }
            ]
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "exec",
        status: "succeeded",
        duration_ms: 9000
      })
    );
    expect(events.some((event) => event.type === "tool.failed")).toBe(false);
  });

  it("treats function_call_output without an exit code as success, not failure", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-no-exit.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_no_exit",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_no_exit_1",
            name: "shell_command",
            arguments: JSON.stringify({
              command: "rg -n pattern src",
              workdir: "D:/projects/dev"
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_no_exit_1",
            output: ["Wall time: 0.0643 seconds", "Output:", "src/a.ts:1:hit"].join("\n")
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:06.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_nonzero_1",
            name: "shell_command",
            arguments: JSON.stringify({
              command: "rg -n missing src",
              workdir: "D:/projects/dev"
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:07.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_nonzero_1",
            output: ["Exit code: 1", "Wall time: 0.1 seconds", "Output:"].join("\n")
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "rg",
        status: "succeeded",
        duration_ms: 64
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.failed",
        tool_name: "rg",
        status: "failed",
        duration_ms: 100
      })
    );
  });

  it("maps exec_command function calls into normalized tool events on macOS", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "/Users/test/.codex/sessions/2026/05/28/rollout-exec-command.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_exec_fn",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "/Users/test/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_exec_fn_1",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "sed -n '1,120p' README.md",
              workdir: "/Users/test/dev",
              yield_time_ms: 1000,
              max_output_tokens: 4000
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_exec_fn_1",
            output: [
              "Chunk ID: test123",
              "Wall time: 0.0004 seconds",
              "Process exited with code 0",
              "Output:",
              "# Agent Metrics"
            ].join("\n")
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "sed",
        status: "succeeded",
        duration_ms: 0
      })
    );
  });

  it("ignores non-shell function calls and keeps only real command-backed tools", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-internal-function.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_internal_fn",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_internal_fn_1",
            name: "update_plan",
            arguments: JSON.stringify({
              plan: []
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:04.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_internal_fn_1",
            output: "Plan updated"
          }
        })
      ].join("\n")
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "session.started",
        session_id: "ses_internal_fn"
      })
    ]);
  });

  it("extracts the real command name from PowerShell shell_command wrappers", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-shell-wrapper.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_shell_wrapper",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_shell_wrapper_1",
            name: "shell_command",
            arguments: JSON.stringify({
              command:
                "$json = Invoke-RestMethod \"http://127.0.0.1:45183/api/tools?mode=calendar&range=day&sourceVendor=codex\"",
              workdir: "D:/projects/dev",
              timeout_ms: 20000
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_shell_wrapper_1",
            output: ["Exit code: 0", "Wall time: 2.7 seconds"].join("\n")
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:06.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_shell_wrapper_2",
            name: "shell_command",
            arguments: JSON.stringify({
              command: "$conn=get-nettcpconnection -LocalPort 45183",
              workdir: "D:/projects/dev",
              timeout_ms: 20000
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:08.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_shell_wrapper_2",
            output: ["Exit code: 0", "Wall time: 4.9 seconds"].join("\n")
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "invoke-restmethod",
        duration_ms: 2700
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "get-nettcpconnection",
        duration_ms: 4900
      })
    );
  });

  it("extracts the real command name from exec_command_end shell wrappers on macOS and Windows", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "/Users/test/.codex/sessions/2026/05/28/rollout-exec-command-end.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "ses_exec_end",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "/Users/test/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "call_exec_end_1",
            command: ["/bin/zsh", "-lc", "sed -n '1,120p' README.md"],
            cwd: "/Users/test/dev",
            stdout: "",
            stderr: "",
            exit_code: 0,
            duration: { secs: 0, nanos: 20000000 },
            status: "completed"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "exec_command_end",
            call_id: "call_exec_end_2",
            command: [
              "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
              "-Command",
              "Get-Content README.md"
            ],
            cwd: "D:/projects/dev",
            stdout: "",
            stderr: "",
            exit_code: 0,
            duration: { secs: 0, nanos: 30000000 },
            status: "completed"
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "sed",
        status: "succeeded",
        duration_ms: 20
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "get-content",
        status: "succeeded",
        duration_ms: 30
      })
    );
  });

  it("maps user_message and agent_message rollout events into prompt and response events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-2026-05-28T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
      sessionModels: {
        "019e5dc9-b10c-7371-8edd-066e8db7e50d": "gpt-5.4"
      },
      providerConfigs: {
        ai: {
          baseUrl: "https://api.psydo.top",
          host: "api.psydo.top"
        }
      },
      contents: [
        JSON.stringify({
          timestamp: "2026-05-28T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
            timestamp: "2026-05-28T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Review the changes."
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-28T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Reading the diff now.",
            phase: "commentary"
          }
        })
      ].join("\n")
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "prompt.submitted",
        session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
        prompt_chars: 19
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "assistant.responded",
        session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
        model: "gpt-5.4",
        provider_id: "ai",
        provider_base_url: "https://api.psydo.top",
        provider_host: "api.psydo.top",
        response_chars: 21,
        stop_reason: "commentary"
      })
    );

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("maps session and token snapshots into normalized Codex events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/27/rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
      sessionModels: {
        "019e5dc9-b10c-7371-8edd-066e8db7e50d": "gpt-5.4"
      },
      providerConfigs: {
        ai: {
          baseUrl: "https://api.psydo.top",
          host: "api.psydo.top"
        }
      },
      contents: [
        JSON.stringify({
          timestamp: "2026-05-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
            timestamp: "2026-05-27T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:12.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 29619,
                cached_input_tokens: 6912,
                output_tokens: 702,
                reasoning_output_tokens: 333,
                total_tokens: 30321
              },
              last_token_usage: {
                input_tokens: 15928,
                cached_input_tokens: 3456,
                output_tokens: 202,
                reasoning_output_tokens: 37,
                total_tokens: 16130
              }
            }
          }
        })
      ].join("\n")
    });

    expect(events).toEqual([
      expect.objectContaining({
        source_record_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:started",
        session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
        source_vendor: "codex",
        source_adapter: "codex-rollout",
        type: "session.started"
      }),
      expect.objectContaining({
        source_record_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:usage:30321",
        session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
        type: "token.usage.recorded",
        message_id: "usage_30321",
        model: "gpt-5.4",
        input_tokens: 15928,
        output_tokens: 239,
        cache_read_input_tokens: 3456,
        cache_creation_input_tokens: 0,
        usage_source: "codex-rollout",
        provider_id: "ai",
        provider_base_url: "https://api.psydo.top",
        provider_host: "api.psydo.top"
      })
    ]);

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("estimates decode duration from the gap between consecutive token_count events", () => {
    const tokenCount = (timestamp: string, totalTokens: number, output: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            }
          }
        }
      });

    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/27/rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
            timestamp: "2026-05-27T10:00:00.000Z",
            cwd: "D:/projects/dev"
          }
        }),
        tokenCount("2026-05-27T10:00:12.000Z", 1100, 100),
        tokenCount("2026-05-27T10:00:20.500Z", 1300, 200)
      ].join("\n")
    });

    const usageEvents = events.filter((event) => event.type === "token.usage.recorded");
    expect(usageEvents).toHaveLength(2);
    // First usage event has no predecessor, so no estimate.
    expect(usageEvents[0]).toEqual(
      expect.objectContaining({ decode_duration_ms: null, first_token_latency_ms: null })
    );
    expect(usageEvents[1]).toEqual(
      expect.objectContaining({ decode_duration_ms: 8500, first_token_latency_ms: null })
    );
  });

  it("drops decode estimates across turn boundaries and implausible gaps", () => {
    const tokenCount = (timestamp: string, totalTokens: number, output: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            }
          }
        }
      });
    const taskStarted = (timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "task_started" }
      });

    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/27/rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
            timestamp: "2026-05-27T10:00:00.000Z",
            cwd: "D:/projects/dev"
          }
        }),
        tokenCount("2026-05-27T10:00:10.000Z", 1100, 100),
        // A new turn starts: the 5-minute gap must not count as decoding.
        taskStarted("2026-05-27T10:05:00.000Z"),
        tokenCount("2026-05-27T10:05:08.000Z", 1300, 200),
        // Same turn, but a 10-minute gap is tool/idle time, not decode.
        tokenCount("2026-05-27T10:15:08.000Z", 1500, 300),
        tokenCount("2026-05-27T10:15:15.000Z", 1700, 400)
      ].join("\n")
    });

    const usageEvents = events.filter((event) => event.type === "token.usage.recorded");
    expect(usageEvents.map((event) => event.decode_duration_ms)).toEqual([
      null,
      null,
      null,
      7000
    ]);
  });

  it("derives first-token latency from the turn start for the turn's first token_count report", () => {
    const tokenCount = (timestamp: string, totalTokens: number, output: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            }
          }
        }
      });
    const taskStarted = (timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "task_started",
          started_at: Math.floor(Date.parse(timestamp) / 1000)
        }
      });

    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/27/rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
            timestamp: "2026-05-27T10:00:00.000Z",
            cwd: "D:/projects/dev"
          }
        }),
        taskStarted("2026-05-27T10:00:00.000Z"),
        tokenCount("2026-05-27T10:00:12.000Z", 1100, 100),
        tokenCount("2026-05-27T10:00:20.500Z", 1300, 200)
      ].join("\n")
    });

    const usageEvents = events.filter((event) => event.type === "token.usage.recorded");
    expect(usageEvents).toHaveLength(2);
    // The turn start comes from started_at (unix seconds); the first report carries
    // the latency and has no predecessor to measure a decode window against.
    expect(usageEvents[0]).toEqual(
      expect.objectContaining({ first_token_latency_ms: 12000, decode_duration_ms: null })
    );
    // A later report in the same turn is a mid-stream snapshot, so only decode moves.
    expect(usageEvents[1]).toEqual(
      expect.objectContaining({ first_token_latency_ms: null, decode_duration_ms: 8500 })
    );

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("resets the first-token anchor per turn and drops implausible latencies", () => {
    const tokenCount = (timestamp: string, totalTokens: number, output: number) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 0,
              output_tokens: output,
              reasoning_output_tokens: 0,
              total_tokens: totalTokens
            }
          }
        }
      });
    const taskStartedWithoutStartedAt = (timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "task_started" }
      });
    const taskStarted = (timestamp: string) =>
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "task_started",
          started_at: Math.floor(Date.parse(timestamp) / 1000)
        }
      });

    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/27/rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
      contents: [
        JSON.stringify({
          timestamp: "2026-05-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
            timestamp: "2026-05-27T10:00:00.000Z",
            cwd: "D:/projects/dev"
          }
        }),
        // No turn has started yet, so this report has no anchor at all.
        tokenCount("2026-05-27T10:00:10.000Z", 1100, 100),
        // Rollouts without started_at fall back to the row timestamp.
        taskStartedWithoutStartedAt("2026-05-27T10:05:00.000Z"),
        tokenCount("2026-05-27T10:05:08.000Z", 1300, 200),
        tokenCount("2026-05-27T10:05:15.000Z", 1500, 300),
        // A new turn whose first report is 20 minutes late: idle, not a slow start.
        taskStarted("2026-05-27T10:30:00.000Z"),
        tokenCount("2026-05-27T10:50:00.000Z", 1700, 400),
        tokenCount("2026-05-27T10:50:07.000Z", 1900, 500)
      ].join("\n")
    });

    const usageEvents = events.filter((event) => event.type === "token.usage.recorded");
    expect(usageEvents.map((event) => event.first_token_latency_ms)).toEqual([
      null,
      8000,
      null,
      null,
      null
    ]);
    expect(usageEvents.map((event) => event.decode_duration_ms)).toEqual([
      null,
      null,
      7000,
      null,
      7000
    ]);

    for (const event of events) {
      expect(NormalizedEventV2Schema.safeParse(event).success).toBe(true);
    }
  });

  it("tags Multica rollouts via path and originator as codex:multica", () => {
    const byPath = extractCodexEventsFromRollout({
      filePath:
        "C:/Users/test/.codex/multica-sessions/p_abc/task/id/2026/07/30/rollout-2026-07-30T10-00-00-019fb0ea-92d6-7a61-afbe-3c3385675400.jsonl",
      contents: JSON.stringify({
        timestamp: "2026-07-30T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019fb0ea-92d6-7a61-afbe-3c3385675400",
          timestamp: "2026-07-30T10:00:00.000Z",
          cwd: "D:/projects/dev",
          model_provider: "ai"
        }
      })
    });

    expect(byPath[0]).toEqual(
      expect.objectContaining({
        type: "session.started",
        source_vendor: "codex",
        source_instance_id: "codex:multica",
        adapter_instance_id: "codex-rollout@codex:multica"
      })
    );

    const byOriginator = extractCodexEventsFromRollout({
      filePath:
        "C:/Users/test/.codex/sessions/2026/07/30/rollout-2026-07-30T10-00-00-019fb0ea-92d6-7a61-afbe-3c3385675400.jsonl",
      contents: JSON.stringify({
        timestamp: "2026-07-30T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019fb0ea-92d6-7a61-afbe-3c3385675400",
          timestamp: "2026-07-30T10:00:00.000Z",
          cwd: "D:/projects/dev",
          originator: "multica-agent-sdk",
          model_provider: "ai"
        }
      })
    });

    expect(byOriginator[0]).toEqual(
      expect.objectContaining({
        type: "session.started",
        source_instance_id: "codex:multica"
      })
    );
  });
});
