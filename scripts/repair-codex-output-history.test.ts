import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { semanticFingerprint, toNormalizedEventV2 } from "../packages/event-schema/dist/index.js";
import { describe, expect, it } from "vitest";
import { createEventLogCursor, readEventLogIncremental } from "../apps/core/src/raw-ingest.js";
import { runDomainMigrations } from "../apps/core/src/domain-migrations.js";
import { projectNormalizedEvents } from "../apps/core/src/domain-projection.js";
import { repairCodexOutputHistory } from "./repair-codex-output-history.mjs";

const require = createRequire(new URL("../apps/core/package.json", import.meta.url));
const Database = require("better-sqlite3");

const timestamp = "2026-10-17T04:05:06.000Z";
const sessionId = "019f6f83-63b3-7e60-a60d-9761c6f50001";
const nativeId = `codex:session:${sessionId}:usage:29`;
const mismatchSessionId = "019f6f83-63b3-7e60-a60d-9761c6f50002";
const mismatchNativeId = `codex:session:${mismatchSessionId}:usage:29`;

describe("repairCodexOutputHistory", () => {
  it("repairs the matched historical row once and keeps the JSONL cursor replay-safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-output-history-repair-"));
    const dataRoot = join(root, "data-root");
    const backupDir = join(root, "backup");
    const dbPath = join(dataRoot, "data", "sqlite", "metrics.sqlite");
    const logPath = join(dataRoot, "data", "events", "events.jsonl");
    const cursorPath = join(dataRoot, "data", "sources", "state", "codex-cursor.json");
    const rolloutPath = join(root, "rollout-fixture-" + sessionId + ".jsonl");
    const mismatchRolloutPath = join(root, "rollout-fixture-" + mismatchSessionId + ".jsonl");

    try {
      await mkdir(join(dataRoot, "data", "sqlite"), { recursive: true });
      await mkdir(join(dataRoot, "data", "events"), { recursive: true });
      await mkdir(join(dataRoot, "data", "sources", "state"), { recursive: true });
      await mkdir(backupDir, { recursive: true });

      const event = toNormalizedEventV2(
        {
          event_id: nativeId,
          session_id: sessionId,
          timestamp,
          source_vendor: "codex",
          source_adapter: "codex-rollout",
          workspace_path: "/workspace",
          type: "token.usage.recorded",
          message_id: "usage_29",
          model: "gpt-6.1-sol",
          input_tokens: 20,
          output_tokens: 15,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: "{}",
          usage_source: "codex-rollout",
          first_token_latency_ms: 250,
          decode_duration_ms: 1_000,
          provider_id: "openai"
        },
        { sourceInstanceId: "codex:default", sourceRecordId: nativeId }
      );
      const mismatchEvent = toNormalizedEventV2(
        {
          event_id: mismatchNativeId,
          session_id: mismatchSessionId,
          timestamp,
          source_vendor: "codex",
          source_adapter: "codex-rollout",
          workspace_path: "/workspace",
          type: "token.usage.recorded",
          message_id: "usage_29",
          model: "gpt-6.1-sol",
          input_tokens: 21,
          output_tokens: 15,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: "{}",
          usage_source: "codex-rollout",
          first_token_latency_ms: null,
          decode_duration_ms: null,
          provider_id: "openai"
        },
        { sourceInstanceId: "codex:default", sourceRecordId: mismatchNativeId }
      );

      const eventLine = JSON.stringify(event);
      const mismatchEventLine = JSON.stringify(mismatchEvent);
      const initialLog = `${eventLine}\n${mismatchEventLine}\n`;
      await writeFile(logPath, initialLog, "utf8");
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            timestamp,
            type: "session_meta",
            payload: { id: sessionId, cwd: "/workspace", model_provider: "openai" }
          }),
          JSON.stringify({
            timestamp,
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { total_tokens: 29 },
                last_token_usage: {
                  total_tokens: 29,
                  input_tokens: 20,
                  output_tokens: 9,
                  reasoning_output_tokens: 6
                }
              }
            }
          })
        ].join("\n") + "\n",
        "utf8"
      );
      await writeFile(
        mismatchRolloutPath,
        [
          JSON.stringify({
            timestamp,
            type: "session_meta",
            payload: { id: mismatchSessionId, cwd: "/workspace", model_provider: "openai" }
          }),
          JSON.stringify({
            timestamp,
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: { total_tokens: 29 },
                last_token_usage: {
                  total_tokens: 29,
                  input_tokens: 20,
                  output_tokens: 9,
                  reasoning_output_tokens: 6
                }
              }
            }
          })
        ].join("\n") + "\n",
        "utf8"
      );

      const db = new Database(dbPath);
      runDomainMigrations(db);
      db.exec(`
        CREATE TABLE token_usage_events (event_id TEXT PRIMARY KEY, output_tokens INTEGER NOT NULL);
        CREATE TABLE ingestion_state (
          stream_name TEXT PRIMARY KEY,
          offset_bytes INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          file_identity TEXT,
          committed_prefix_hash TEXT
        );
      `);
      projectNormalizedEvents(db as never, [event, mismatchEvent]);
      db.prepare("INSERT INTO token_usage_events (event_id, output_tokens) VALUES (?, ?)").run(event.event_id, 15);
      db.prepare("INSERT INTO token_usage_events (event_id, output_tokens) VALUES (?, ?)").run(mismatchEvent.event_id, 15);

      const initialCursor = await createEventLogCursor(logPath, Buffer.byteLength(initialLog));
      const initialStat = await import("node:fs/promises").then(({ stat }) => stat(logPath));
      db.prepare(`INSERT INTO ingestion_state
        (stream_name, offset_bytes, size_bytes, mtime_ms, file_identity, committed_prefix_hash)
        VALUES ('events.jsonl', ?, ?, ?, ?, ?)`)
        .run(initialCursor.committedOffset, initialStat.size, initialStat.mtimeMs, initialCursor.fileIdentity, initialCursor.committedPrefixHash);
      db.close();

      const cursor = {
        rolloutFiles: {
          [rolloutPath]: {
            parserState: { pendingEvents: [event] }
          },
          [mismatchRolloutPath]: {
            parserState: { pendingEvents: [mismatchEvent] }
          }
        }
      };
      await writeFile(cursorPath, JSON.stringify(cursor), "utf8");
      await copyFile(dbPath, join(backupDir, "metrics.sqlite"));
      await copyFile(logPath, join(backupDir, "events.jsonl"));

      const dryRun = await repairCodexOutputHistory({
        dataRoot,
        rolloutPaths: [rolloutPath, mismatchRolloutPath]
      });
      expect(dryRun).toMatchObject({
        applied: false,
        rows: 2,
        matched: 1,
        correctedRows: 1,
        removedDuplicateTokens: 6,
        models: {
          "codex/gpt-6.1-sol": {
            speedBefore: 15,
            speedAfter: 9
          }
        }
      });
      expect(JSON.parse((await readFile(logPath, "utf8")).split("\n")[0]!).output_tokens).toBe(15);

      const applied = await repairCodexOutputHistory({
        dataRoot,
        apply: true,
        backupDir,
        rolloutPaths: [rolloutPath, mismatchRolloutPath]
      });
      expect(applied).toMatchObject({
        applied: true,
        correctedRows: 1,
        removedDuplicateTokens: 6,
        patchedLogRows: 1,
        cursorChanges: 1,
        models: {
          "codex/gpt-6.1-sol": {
            speedBefore: 15,
            speedAfter: 9
          }
        }
      });

      const correctedLog = await readFile(logPath, "utf8");
      const correctedLines = correctedLog.trimEnd().split("\n");
      const correctedEvent = JSON.parse(correctedLines[0]!);
      const untouchedEvent = JSON.parse(correctedLines[1]!);
      expect(correctedEvent.output_tokens).toBe(9);
      expect(untouchedEvent.output_tokens).toBe(15);
      expect(Buffer.byteLength(correctedLog)).toBe(Buffer.byteLength(initialLog));
      expect(JSON.parse(await readFile(cursorPath, "utf8")).rolloutFiles[rolloutPath].parserState.pendingEvents[0].output_tokens).toBe(9);
      expect(JSON.parse(await readFile(cursorPath, "utf8")).rolloutFiles[mismatchRolloutPath].parserState.pendingEvents[0].output_tokens).toBe(15);

      const verifyDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      const normalized = verifyDb.prepare("SELECT payload_json, semantic_fingerprint FROM normalized_events WHERE event_id = ?").get(event.event_id) as {
        payload_json: string;
        semantic_fingerprint: string;
      };
      const usage = verifyDb.prepare("SELECT output_tokens, semantic_fingerprint FROM usage_events WHERE event_id = ?").get(event.event_id) as {
        output_tokens: number;
        semantic_fingerprint: string;
      };
      const legacy = verifyDb.prepare("SELECT output_tokens FROM token_usage_events WHERE event_id = ?").get(event.event_id);
      const untouchedUsage = verifyDb.prepare("SELECT output_tokens FROM usage_events WHERE event_id = ?").get(mismatchEvent.event_id);
      const untouchedLegacy = verifyDb.prepare("SELECT output_tokens FROM token_usage_events WHERE event_id = ?").get(mismatchEvent.event_id);
      const observation = verifyDb.prepare("SELECT semantic_fingerprint FROM event_observations WHERE event_id = ?").get(event.event_id);
      const state = verifyDb.prepare("SELECT offset_bytes, size_bytes, file_identity, committed_prefix_hash FROM ingestion_state WHERE stream_name = 'events.jsonl'").get() as {
        offset_bytes: number;
        size_bytes: number;
        file_identity: string;
        committed_prefix_hash: string;
      };
      verifyDb.close();

      const canonicalEvent = JSON.parse(normalized.payload_json);
      const expectedFingerprint = semanticFingerprint(correctedEvent);
      expect(canonicalEvent.output_tokens).toBe(9);
      expect(normalized.semantic_fingerprint).toBe(expectedFingerprint);
      expect(usage).toEqual({ output_tokens: 9, semantic_fingerprint: expectedFingerprint });
      expect(legacy).toEqual({ output_tokens: 9 });
      expect(untouchedUsage).toEqual({ output_tokens: 15 });
      expect(untouchedLegacy).toEqual({ output_tokens: 15 });
      expect(observation).toEqual({ semantic_fingerprint: expectedFingerprint });

      const cursorRead = await readEventLogIncremental({
        filePath: logPath,
        cursor: {
          fileIdentity: state.file_identity,
          committedOffset: state.offset_bytes,
          committedPrefixHash: state.committed_prefix_hash
        }
      });
      expect(state.offset_bytes).toBe(state.size_bytes);
      expect(cursorRead.reset).toBe(false);
      expect(cursorRead.records).toHaveLength(0);

      const secondApply = await repairCodexOutputHistory({
        dataRoot,
        apply: true,
        backupDir,
        rolloutPaths: [rolloutPath, mismatchRolloutPath]
      });
      expect(secondApply).toMatchObject({
        applied: true,
        correctedRows: 0,
        removedDuplicateTokens: 0,
        patchedLogRows: 0,
        cursorChanges: 0
      });
      expect((await readFile(logPath, "utf8")).trimEnd()).toBe(correctedLog.trimEnd());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
