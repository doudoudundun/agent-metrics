import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { excludeCodexToolTiming } from "./codex-timing.js";
import type { MetricsDatabase } from "./core-types.js";

function database() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tool_calls (
    source_instance_id TEXT, session_id TEXT, started_at TEXT, finished_at TEXT
  )`);
  return db;
}

function usage(overrides = {}) {
  return {
    source_vendor: "codex", usage_source: "codex-rollout",
    source_instance_id: "codex:default", session_id: "session-a",
    created_at: "2026-10-24T00:00:19.292Z", decode_duration_ms: 9292,
    first_token_latency_ms: null as number | null, output_tokens: 300,
    ...overrides
  };
}

function tool(db: ReturnType<typeof database>, start: string | null, end: string | null,
  source = "codex:default", session = "session-a") {
  db.prepare("INSERT INTO tool_calls VALUES (?, ?, ?, ?)").run(source, session, start, end);
}

describe("excludeCodexToolTiming", () => {
  it("excludes the measured 9.292-second tool interval without mutating tokens or stored data", () => {
    const db = database();
    try {
      tool(db, "2026-10-24T00:00:11.000Z", "2026-10-24T00:00:18.000Z");
      const row = usage();
      expect(excludeCodexToolTiming(db as unknown as MetricsDatabase, [row]))
        .toEqual([{ ...row, decode_duration_ms: null }]);
      expect(row.decode_duration_ms).toBe(9292);
      expect(db.prepare("SELECT count(*) n FROM tool_calls").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it("keeps source/session boundaries and non-Codex telemetry independent", () => {
    const db = database();
    try {
      tool(db, "2026-10-24T00:00:11.000Z", "2026-10-24T00:00:18.000Z", "codex:other");
      tool(db, "2026-10-24T00:00:11.000Z", "2026-10-24T00:00:18.000Z", "codex:default", "session-b");
      const rows = [usage(), usage({ source_vendor: "claude-code" }), usage({ usage_source: "direct-api" })];
      expect(excludeCodexToolTiming(db as unknown as MetricsDatabase, rows)).toEqual(rows);
    } finally { db.close(); }
  });

  it("excludes enclosing and boundary-touching tools, but does not extend an unpaired tool forever", () => {
    const db = database();
    try {
      tool(db, "2026-10-24T00:00:01.000Z", null);
      tool(db, "2026-10-24T00:00:02.000Z", "2026-10-24T00:00:08.000Z");
      const rows = [
        usage({ created_at: "2026-10-24T00:00:06.000Z", decode_duration_ms: 1000 }),
        usage({ created_at: "2026-10-24T00:00:09.000Z", decode_duration_ms: 1000 }),
        usage()
      ];
      expect(excludeCodexToolTiming(db as unknown as MetricsDatabase, rows).map(r => r.decode_duration_ms))
        .toEqual([null, null, 9292]);
    } finally { db.close(); }
  });

  it("filters first-report latency independently of a clean decode interval", () => {
    const db = database();
    try {
      tool(db, null, "2026-10-24T00:00:05.000Z");
      const row = usage({ first_token_latency_ms: 19000 });
      expect(excludeCodexToolTiming(db as unknown as MetricsDatabase, [row]))
        .toEqual([{ ...row, first_token_latency_ms: null }]);
    } finally { db.close(); }
  });
});
