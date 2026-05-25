import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import { buildApp, ingestEventLog, resolveDefaultDbPath } from "./app.js";

let dbPath: string;
let logPath: string;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-metrics-core-"));
  dbPath = join(root, "metrics.sqlite");
  logPath = join(root, "events.jsonl");
});

describe("ingestEventLog", () => {
  it("stores succeeded and failed tool events into SQLite-backed overview rows", async () => {
    await appendJsonLine(logPath, {
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    await appendJsonLine(logPath, {
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.succeeded",
      tool_name: "Read",
      status: "succeeded",
      duration_ms: 14
    });

    await appendJsonLine(logPath, {
      event_id: "evt_3",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:02.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.failed",
      tool_name: "Write",
      status: "failed",
      duration_ms: 21
    });

    const app = buildApp({ dbPath });
    await ingestEventLog({ app, eventLogPath: logPath });
    const response = await app.inject({ method: "GET", url: "/api/overview" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalToolCalls: 2,
      successfulExecutions: 1,
      sessionCount: 1
    });

    await app.close();
  });

  it("creates the SQLite parent directory and closes the database on shutdown", async () => {
    const nestedDbPath = join(tmpdir(), "agent-metrics-core-nested", randomUUID(), "sqlite", "metrics.sqlite");

    const app = buildApp({ dbPath: nestedDbPath });

    expect(existsSync(dirname(nestedDbPath))).toBe(true);

    await app.close();

    expect(() => app.db.prepare("SELECT 1").get()).toThrow();
  });

  it("resolves the default database path from the repository root", () => {
    const serverModuleUrl = new URL("./server.ts", import.meta.url).href;

    expect(resolveDefaultDbPath(serverModuleUrl)).toBe(
      resolve(process.cwd(), "..", "..", "data", "sqlite", "metrics.sqlite")
    );
  });
});
