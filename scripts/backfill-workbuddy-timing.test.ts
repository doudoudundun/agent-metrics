import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { semanticFingerprint, toNormalizedEventV2 } from "../packages/event-schema/dist/index.js";
import {
  createWorkbuddyParseState,
  normalizeWorkbuddyRecord
} from "../packages/adapters-workbuddy/dist/index.js";
import { createEventLogCursor } from "../apps/core/src/raw-ingest.js";
import { runDomainMigrations } from "../apps/core/src/domain-migrations.js";
import { projectNormalizedEvents } from "../apps/core/src/domain-projection.js";
import { describe, expect, it } from "vitest";
import { backfillWorkbuddyTiming } from "./backfill-workbuddy-timing.mjs";

const require = createRequire(new URL("../apps/core/package.json", import.meta.url));
const Database = require("better-sqlite3");

const sessionId = "6b0b1a5e-6f0c-4b6f-9d3e-2c1c1f2a0001";
const workspace = "/workspace";
const base = Date.parse("2026-10-24T00:00:00.000Z");

function transcript(times: { prompt: number; tool: number; result: number; answer: number }) {
  return [
    {
      type: "message",
      role: "user",
      id: "u1",
      sessionId,
      cwd: workspace,
      timestamp: times.prompt
    },
    {
      type: "function_call",
      id: "c1",
      name: "Read",
      input: { file_path: "/workspace/a.ts" },
      sessionId,
      cwd: workspace,
      timestamp: times.tool,
      providerData: { stepSeq: 1, messageId: "m1", model: "deepseek-v4.1-flash", usage: { inputTokens: 100, outputTokens: 20 } }
    },
    {
      type: "function_call_result",
      id: "r1",
      name: "Read",
      sessionId,
      cwd: workspace,
      timestamp: times.result,
      providerData: { stepSeq: 1 }
    },
    {
      type: "function_call",
      id: "c2",
      name: "Read",
      input: { file_path: "/workspace/b.ts" },
      sessionId,
      cwd: workspace,
      timestamp: times.answer,
      providerData: { stepSeq: 2, messageId: "m2", model: "deepseek-v4.1-flash", usage: { inputTokens: 120, outputTokens: 40 } }
    }
  ];
}

describe("backfillWorkbuddyTiming", () => {
  it("writes the derived decode window into the event log and the projection once", async () => {
    const root = await mkdtemp(join(tmpdir(), "workbuddy-timing-backfill-"));
    const dataRoot = join(root, "data-root");
    const backupDir = join(root, "backup");
    const workbuddyHome = join(root, "wb-home");
    const dbPath = join(dataRoot, "data", "sqlite", "metrics.sqlite");
    const logPath = join(dataRoot, "data", "events", "events.jsonl");
    const sessionLogPath = join(workbuddyHome, "projects", "workspace-slug", `${sessionId}.jsonl`);

    try {
      await mkdir(join(dataRoot, "data", "sqlite"), { recursive: true });
      await mkdir(join(dataRoot, "data", "events"), { recursive: true });
      await mkdir(join(workbuddyHome, "projects", "workspace-slug"), { recursive: true });
      await mkdir(backupDir, { recursive: true });

      const times = { prompt: base, tool: base + 1_000, result: base + 2_000, answer: base + 17_000 };
      await writeFile(
        sessionLogPath,
        transcript(times).map((record) => JSON.stringify(record)).join("\n") + "\n",
        "utf8"
      );

      const state = createWorkbuddyParseState();
      const derived = transcript(times).flatMap((record) =>
        normalizeWorkbuddyRecord(record, sessionId, workspace, state)
      );
      const usages = derived.filter((event) => event.type === "token.usage.recorded");
      expect(usages).toHaveLength(2);
      expect(usages[0].decode_duration_ms).toBeNull();
      expect(usages[1].decode_duration_ms).toBe(15_000);

      // The historical row was written before the derivation existed: same
      // identity, same counters, no timing.
      const stale = toNormalizedEventV2(
        { ...usages[1], decode_duration_ms: null },
        {
          sourceInstanceId: "workbuddy:default",
          sourceRecordId: `workbuddy:${sessionId}:usage:m2`
        }
      );
      const untouched = toNormalizedEventV2(
        { ...usages[0], decode_duration_ms: null },
        {
          sourceInstanceId: "workbuddy:default",
          sourceRecordId: `workbuddy:${sessionId}:usage:m1`
        }
      );
      const untouchedLine = JSON.stringify(untouched);
      const staleLine = JSON.stringify(stale);
      const initialLog = `${untouchedLine}\n${staleLine}\n`;
      await writeFile(logPath, initialLog, "utf8");

      const db = new Database(dbPath);
      runDomainMigrations(db);
      db.exec(`
        CREATE TABLE ingestion_state (
          stream_name TEXT PRIMARY KEY,
          offset_bytes INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          mtime_ms REAL NOT NULL,
          file_identity TEXT,
          committed_prefix_hash TEXT
        );
      `);
      projectNormalizedEvents(db as never, [untouched, stale]);
      const cursor = await createEventLogCursor(logPath, Buffer.byteLength(initialLog));
      const initialStat = await stat(logPath);
      db.prepare(
        `INSERT INTO ingestion_state
          (stream_name, offset_bytes, size_bytes, mtime_ms, file_identity, committed_prefix_hash)
          VALUES ('events.jsonl', ?, ?, ?, ?, ?)`
      ).run(cursor.committedOffset, initialStat.size, initialStat.mtimeMs, cursor.fileIdentity, cursor.committedPrefixHash);
      db.close();

      await copyFile(dbPath, join(backupDir, "metrics.sqlite"));
      await copyFile(logPath, join(backupDir, "events.jsonl"));

      const dryRun = await backfillWorkbuddyTiming({ dataRoot, workbuddyHome });
      expect(dryRun).toMatchObject({
        applied: false,
        derivedFacts: 1,
        workbuddyRows: 2,
        derivableRows: 1,
        changes: 1
      });

      const applied = await backfillWorkbuddyTiming({ dataRoot, workbuddyHome, apply: true, backupDir });
      expect(applied).toMatchObject({ applied: true, patchedLogRows: 1, changes: 1 });

      const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(untouchedLine);
      const patched = JSON.parse(lines[1]);
      expect(patched.decode_duration_ms).toBe(15_000);
      expect({ ...patched, decode_duration_ms: null }).toEqual(JSON.parse(staleLine));
      const newSize = (await stat(logPath)).size;

      const check = new Database(dbPath, { readonly: true });
      try {
        const rows = check
          .prepare(
            `SELECT u.message_id, u.decode_duration_ms, u.semantic_fingerprint, n.payload_json
               FROM usage_events u JOIN normalized_events n ON n.event_id = u.event_id
              ORDER BY u.message_id`
          )
          .all();
        expect(rows.map((row: { message_id: string; decode_duration_ms: number | null }) => [row.message_id, row.decode_duration_ms]))
          .toEqual([
            ["m1", null],
            ["m2", 15_000]
          ]);
        const m2 = rows[1];
        expect(m2.semantic_fingerprint).toBe(semanticFingerprint(JSON.parse(m2.payload_json)));
        const state = check.prepare("SELECT offset_bytes, size_bytes FROM ingestion_state").get();
        expect(state).toMatchObject({ offset_bytes: newSize, size_bytes: newSize });
      } finally {
        check.close();
      }

      const again = await backfillWorkbuddyTiming({ dataRoot, workbuddyHome });
      expect(again).toMatchObject({ applied: false, changes: 0, derivableRows: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
