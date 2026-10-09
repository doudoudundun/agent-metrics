import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolateSources, type IsolatedSources } from "@agent-metrics/test-utils";
import { resolveMiMoSourcePaths, syncMiMoDatabase } from "./mimo-sync.js";

type SyncFixture = {
  root: string;
  dbPath: string;
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
};

async function createFixture(prefix: string): Promise<SyncFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    dbPath: join(root, "mimocode.db"),
    eventLogPath: join(root, "events.jsonl"),
    cursorPath: join(root, "mimo-cursor.json"),
    ledgerPath: join(root, "mimo-ledger.json")
  };
}

/**
 * Minimal stand-in for the mimocode schema: the shared OpenCode-family sync only
 * reads these columns from `session` / `message` / `part`.
 */
function createMiMoDatabase(dbPath: string): InstanceType<typeof Database> {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

describe("syncMiMoDatabase", () => {
  let isolated: IsolatedSources | null = null;

  beforeEach(async () => {
    isolated = await isolateSources();
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
  });

  it("reads mimocode rows into mimo events with token usage, and dedupes reruns", async () => {
    const fixture = await createFixture("agent-metrics-mimo-");
    const db = createMiMoDatabase(fixture.dbPath);

    db.prepare(
      "INSERT INTO session (id, directory, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, NULL)"
    ).run("ses_mimo_1", "D:/projects/dev/agent-metrics", 1790045113172, 1790045352176);

    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_mimo_user",
      "ses_mimo_1",
      1790045113244,
      1790045113244,
      JSON.stringify({
        role: "user",
        time: { created: 1790045113244 },
        model: { providerID: "aa-token", modelID: "deepseek-v4.1-flash" }
      })
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_mimo_assistant",
      "ses_mimo_1",
      1790045323904,
      1790045348945,
      JSON.stringify({
        role: "assistant",
        agent: "build",
        modelID: "deepseek-v4.1-flash",
        providerID: "aa-token",
        finish: "tool-calls",
        path: { cwd: "D:/projects/dev/agent-metrics", root: "D:/projects/dev/agent-metrics" },
        tokens: {
          total: 73190,
          input: 21007,
          output: 472,
          reasoning: 127,
          cache: { write: 0, read: 51584 }
        },
        time: { created: 1790045323904, completed: 1790045348945 }
      })
    );

    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_mimo_text",
      "msg_mimo_assistant",
      "ses_mimo_1",
      1790045328762,
      1790045344070,
      JSON.stringify({ type: "text", text: "已完成" })
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_mimo_tool",
      "msg_mimo_assistant",
      "ses_mimo_1",
      1790045353186,
      1790045353467,
      JSON.stringify({
        type: "tool",
        tool: "bash",
        callID: "call_00_abc",
        state: {
          status: "completed",
          input: { command: "Get-ChildItem" },
          time: { start: 1790045353186, end: 1790045353467 }
        }
      })
    );
    db.close();

    await syncMiMoDatabase(fixture);
    await syncMiMoDatabase(fixture);

    const events = (await readFile(fixture.eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events.map((event) => event.source_record_id)).toEqual([
      "opencode:mimo:session:ses_mimo_1:started",
      "opencode:mimo:message:msg_mimo_user:prompt",
      "opencode:mimo:message:msg_mimo_assistant:assistant",
      "opencode:mimo:message:msg_mimo_assistant:usage",
      "opencode:mimo:part:prt_mimo_tool:tool:started",
      "opencode:mimo:part:prt_mimo_tool:tool:succeeded"
    ]);
    expect(events.every((event) => event.source_vendor === "mimo")).toBe(true);
    expect(events.every((event) => event.source_adapter === "mimo-db")).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_record_id: "opencode:mimo:part:prt_mimo_tool:tool:succeeded",
          type: "tool.succeeded",
          tool_name: "bash",
          duration_ms: 281
        }),
        expect.objectContaining({
          source_record_id: "opencode:mimo:message:msg_mimo_assistant:usage",
          type: "token.usage.recorded",
          usage_source: "opencode-message",
          input_token_semantics: "gross",
          usage_measurement: "increment",
          input_tokens: 72591,
          output_tokens: 599,
          cache_read_input_tokens: 51584,
          cache_creation_input_tokens: 0,
          model: "deepseek-v4.1-flash",
          provider_id: "aa-token"
        })
      ])
    );
  });

  it("writes nothing when the source database is absent", async () => {
    const fixture = await createFixture("agent-metrics-mimo-missing-");

    await syncMiMoDatabase(fixture);

    await expect(readFile(fixture.eventLogPath, "utf8")).rejects.toThrow();
  });

  it("syncs sessions without a provider registry", async () => {
    const fixture = await createFixture("agent-metrics-mimo-nomodels-");
    const db = createMiMoDatabase(fixture.dbPath);
    db.prepare(
      "INSERT INTO session (id, directory, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, NULL)"
    ).run("ses_mimo_2", "D:/projects/dev/agent-metrics", 1790045113172, 1790045113172);
    db.close();

    await syncMiMoDatabase(fixture);

    const event = JSON.parse((await readFile(fixture.eventLogPath, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    expect(event).toEqual(
      expect.objectContaining({
        type: "session.started",
        source_vendor: "mimo",
        workspace_path: "D:/projects/dev/agent-metrics"
      })
    );
  });
});

describe("resolveMiMoSourcePaths", () => {
  let isolated: IsolatedSources | null = null;

  beforeEach(async () => {
    isolated = await isolateSources({
      overrides: {
        AGENT_METRICS_MIMO_DB_PATH: "D:/tmp/mimo/mimocode.db",
        AGENT_METRICS_MIMO_MODELS_PATH: "D:/tmp/mimo/models.json"
      }
    });
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
  });

  it("prefers explicit input, then env, then the mimocode default", () => {
    expect(resolveMiMoSourcePaths()).toEqual({
      dbPath: "D:/tmp/mimo/mimocode.db",
      modelsPath: "D:/tmp/mimo/models.json"
    });

    expect(resolveMiMoSourcePaths({ dbPath: "D:/explicit/mimocode.db" })).toEqual({
      dbPath: "D:/explicit/mimocode.db",
      modelsPath: "D:/tmp/mimo/models.json"
    });
  });

  it("resolves a default database path under the mimocode data directory", () => {
    isolated?.cleanup();
    isolated = null;
    delete process.env.AGENT_METRICS_MIMO_DB_PATH;

    expect(resolveMiMoSourcePaths().dbPath).toMatch(/mimocode[\\/]mimocode\.db$/u);
  });
});