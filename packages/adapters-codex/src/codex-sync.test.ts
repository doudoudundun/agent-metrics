import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { syncCodexRollouts } from "./codex-sync.js";

describe("syncCodexRollouts", () => {
  it("syncs rollout token snapshots with model and provider metadata and skips unchanged reruns", async () => {
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
