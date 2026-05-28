import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { syncCodexRollouts } from "./codex-sync.js";

describe("syncCodexRollouts", () => {
  it("syncs turn, tool, edit, and token events and skips unchanged reruns", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codex-"));
    const sessionsRoot = join(root, "sessions");
    const dayRoot = join(sessionsRoot, "2026", "05", "27");
    const rolloutPath = join(
      dayRoot,
      "rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl"
    );
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "codex-cursor.json");
    const ledgerPath = join(root, "codex-ledger.json");
    const logsDbPath = join(root, "logs_2.sqlite");
    const configPath = join(root, "config.toml");

    await mkdir(dayRoot, { recursive: true });
    await writeFile(
      rolloutPath,
      [
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
          timestamp: "2026-05-27T10:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Review the telemetry changes."
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "Reading the diff now.",
            phase: "commentary"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:02.500Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call_shell_fn_1",
            name: "shell_command",
            arguments: JSON.stringify({
              command: "rg -n \"patch_apply_end\" D:/projects/dev/agent-metrics -S",
              workdir: "D:/projects/dev",
              timeout_ms: 10000
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:02.800Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_shell_fn_1",
            output: [
              "Exit code: 0",
              "Wall time: 2.3 seconds",
              "Output:",
              "D:/projects/dev/agent-metrics/src/app.ts:1:..."
            ].join("\n")
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            status: "completed",
            call_id: "call_apply_patch_legacy_1",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch\n"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:04.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_apply_patch_legacy_1",
            output: JSON.stringify({
              output: "Success. Updated the following files:\nM src/app.ts\n",
              metadata: {
                exit_code: 0,
                duration_seconds: 0.4
              }
            })
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:05.000Z",
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
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:06.000Z",
          type: "event_msg",
          payload: {
            type: "web_search_end",
            call_id: "call_web_1",
            query: "codex rollout patch_apply_end",
            action: {
              type: "search"
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:07.000Z",
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
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:15.000Z",
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
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      configPath,
      [
        'model_provider = "ai"',
        "",
        "[model_providers.ai]",
        'base_url = "https://api.psydo.top"'
      ].join("\n"),
      "utf8"
    );

    const db = new Database(logsDbPath);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL DEFAULT 0,
        level TEXT NOT NULL DEFAULT 'INFO',
        target TEXT NOT NULL DEFAULT 'codex_otel.log_only',
        feedback_log_body TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes) VALUES (?, 0, 'INFO', 'codex_otel.log_only', ?, 0)"
    ).run(
      1779876012,
      'event.name="codex.sse_event" conversation.id=019e5dc9-b10c-7371-8edd-066e8db7e50d model=gpt-5.4 slug=gpt-5.4'
    );
    db.close();

    await syncCodexRollouts({
      eventLogPath,
      cursorPath,
      ledgerPath,
      sessionsRoot,
      logsDbPath,
      configPath
    });
    await syncCodexRollouts({
      eventLogPath,
      cursorPath,
      ledgerPath,
      sessionsRoot,
      logsDbPath,
      configPath
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual([
      expect.objectContaining({
        event_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:started",
        type: "session.started"
      }),
      expect.objectContaining({
        type: "prompt.submitted"
      }),
      expect.objectContaining({
        type: "assistant.responded"
      }),
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "rg",
        duration_ms: 2300
      }),
      expect.objectContaining({
        type: "tool.called",
        tool_name: "apply_patch"
      }),
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "apply_patch",
        duration_ms: 400
      }),
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "apply_patch"
      }),
      expect.objectContaining({
        type: "code.edit.applied",
        tool_name: "apply_patch",
        file_count: 1,
        insertions: 2,
        deletions: 1,
        edit_operation_count: 1
      }),
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "WebSearch"
      }),
      expect.objectContaining({
        type: "tool.succeeded",
        tool_name: "PowerShell",
        duration_ms: 2285
      }),
      expect.objectContaining({
        event_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:usage:30321",
        type: "token.usage.recorded",
        model: "gpt-5.4",
        provider_id: "ai",
        provider_base_url: "https://api.psydo.top",
        provider_host: "api.psydo.top"
      })
    ]);
  });
});
