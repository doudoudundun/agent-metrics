import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { syncOpenCodeDatabase } from "./opencode-sync.js";

describe("syncOpenCodeDatabase", () => {
  // Isolate these tests from any real zcode/opencode databases installed on the
  // host machine. syncOpenCodeDatabase reads the zcode DB path from the
  // AGENT_METRICS_ZCODE_DB_PATH env var (falling back to ~/.zcode/cli/db/db.sqlite);
  // on a developer machine that real database exists and would pollute the
  // synthetic event log with thousands of unrelated events. Point it at a path
  // that never exists. Tests that exercise the zcode source override this var.
  const previousZcodeDbPath = process.env.AGENT_METRICS_ZCODE_DB_PATH;
  const previousZcodeModelsPath = process.env.AGENT_METRICS_ZCODE_MODELS_PATH;

  beforeEach(() => {
    process.env.AGENT_METRICS_ZCODE_DB_PATH = join(
      tmpdir(),
      `nonexistent-zcode-${Math.random().toString(36).slice(2)}.sqlite`
    );
    delete process.env.AGENT_METRICS_ZCODE_MODELS_PATH;
  });

  afterEach(() => {
    if (previousZcodeDbPath === undefined) {
      delete process.env.AGENT_METRICS_ZCODE_DB_PATH;
    } else {
      process.env.AGENT_METRICS_ZCODE_DB_PATH = previousZcodeDbPath;
    }
    if (previousZcodeModelsPath === undefined) {
      delete process.env.AGENT_METRICS_ZCODE_MODELS_PATH;
    } else {
      process.env.AGENT_METRICS_ZCODE_MODELS_PATH = previousZcodeModelsPath;
    }
  });

  it("syncs OpenCode rows into normalized events and dedupes reruns", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-"));
    const dbPath = join(root, "opencode.db");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "opencode-cursor.json");
    const ledgerPath = join(root, "opencode-ledger.json");
    const modelsPath = join(root, "models.json");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        workspace_id TEXT,
        path TEXT,
        agent TEXT,
        model TEXT,
        cost REAL NOT NULL DEFAULT 0,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0
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

    db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version, share_url,
        summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
        time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model,
        cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0)
    `).run(
      "ses_open_1",
      "proj_1",
      "slug-1",
      "D:/projects/dev/agent-metrics",
      "Demo",
      "1",
      1777355820000,
      1777355843000
    );

    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_user_1",
      "ses_open_1",
      1777355820355,
      1777355820355,
      JSON.stringify({
        role: "user",
        time: { created: 1777355820355 }
      })
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_assistant_1",
      "ses_open_1",
      1777355829153,
      1777355842420,
      JSON.stringify({
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
    );

    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_user_text",
      "msg_user_1",
      "ses_open_1",
      1777355820355,
      1777355820355,
      JSON.stringify({
        type: "text",
        text: "PopupActivity这个文件能看到里面是什么吗？"
      })
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_assistant_text",
      "msg_assistant_1",
      "ses_open_1",
      1777355840641,
      1777355840641,
      JSON.stringify({
        type: "text",
        text: "找到了！"
      })
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_tool_1",
      "msg_assistant_1",
      "ses_open_1",
      1777355841227,
      1777355841866,
      JSON.stringify({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: {
            filePath: "D:/projects/dev/agent-metrics/src/app.ts"
          },
          time: {
            start: 1777355841852,
            end: 1777355841866
          }
        }
      })
    );
    db.close();
    await writeFile(
      modelsPath,
      JSON.stringify(
        {
          opencode: {
            api: "https://opencode.ai/zen/v1"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath,
      modelsPath
    });
    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath,
      modelsPath
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.map((event) => event.event_id)).toEqual([
      "opencode:session:ses_open_1:started",
      "opencode:message:msg_user_1:prompt",
      "opencode:part:prt_tool_1:tool:started",
      "opencode:part:prt_tool_1:tool:succeeded",
      "opencode:message:msg_assistant_1:assistant",
      "opencode:message:msg_assistant_1:usage"
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: "opencode:message:msg_assistant_1:assistant",
          provider_id: "opencode",
          provider_base_url: "https://opencode.ai/zen/v1",
          provider_host: "opencode.ai"
        }),
        expect.objectContaining({
          event_id: "opencode:message:msg_assistant_1:usage",
          provider_id: "opencode",
          provider_base_url: "https://opencode.ai/zen/v1",
          provider_host: "opencode.ai"
        })
      ])
    );
  });

  it("backfills token usage for assistant messages whose tokens arrive after the initial message sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-late-token-"));
    const dbPath = join(root, "opencode.db");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "opencode-cursor.json");
    const ledgerPath = join(root, "opencode-ledger.json");
    const modelsPath = join(root, "models.json");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        workspace_id TEXT,
        path TEXT,
        agent TEXT,
        model TEXT,
        cost REAL NOT NULL DEFAULT 0,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0
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

    db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version, share_url,
        summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
        time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model,
        cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 0, 0, 0, 0, 0, 0)
    `).run(
      "ses_open_late_token",
      "proj_late_token",
      "slug-late-token",
      "D:/projects/dev/agent-metrics",
      "Late Token Demo",
      "1",
      1777355820000,
      1777355843000,
      "hy3-preview-free"
    );

    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_assistant_late_token",
      "ses_open_late_token",
      1777355829153,
      1777355842420,
      JSON.stringify({
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
        }
      })
    );

    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_assistant_late_token_text",
      "msg_assistant_late_token",
      "ses_open_late_token",
      1777355840641,
      1777355840641,
      JSON.stringify({
        type: "text",
        text: "Waiting for usage."
      })
    );

    db.close();
    await writeFile(
      modelsPath,
      JSON.stringify(
        {
          opencode: {
            api: "https://opencode.ai/zen/v1"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath,
      modelsPath
    });

    const firstPassEvents = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(firstPassEvents.map((event) => event.event_id)).toEqual([
      "opencode:session:ses_open_late_token:started",
      "opencode:message:msg_assistant_late_token:assistant"
    ]);

    const reopenDb = new Database(dbPath);
    reopenDb
      .prepare("UPDATE message SET data = ? WHERE id = ?")
      .run(
        JSON.stringify({
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
            input: 120,
            output: 30,
            reasoning: 10,
            cache: {
              read: 40,
              write: 0
            }
          }
        }),
        "msg_assistant_late_token"
      );
    reopenDb.close();

    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath,
      modelsPath
    });

    const secondPassEvents = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(secondPassEvents.map((event) => event.event_id)).toEqual([
      "opencode:session:ses_open_late_token:started",
      "opencode:message:msg_assistant_late_token:assistant",
      "opencode:message:msg_assistant_late_token:usage"
    ]);
    expect(secondPassEvents[2]).toEqual(
      expect.objectContaining({
        event_id: "opencode:message:msg_assistant_late_token:usage",
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 40,
        provider_host: "opencode.ai"
      })
    );
  });

  it("records token usage from a late step-finish part without waiting for the message row to change", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-step-finish-"));
    const dbPath = join(root, "opencode.db");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "opencode-cursor.json");
    const ledgerPath = join(root, "opencode-ledger.json");
    const modelsPath = join(root, "models.json");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        workspace_id TEXT,
        path TEXT,
        agent TEXT,
        model TEXT,
        cost REAL NOT NULL DEFAULT 0,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write INTEGER NOT NULL DEFAULT 0
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

    db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version, share_url,
        summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
        time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model,
        cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 0, 0, 0, 0, 0, 0)
    `).run(
      "ses_open_step_finish",
      "proj_step_finish",
      "slug-step-finish",
      "D:/projects/dev/agent-metrics",
      "Step Finish Demo",
      "1",
      1777355820000,
      1777355843000,
      "hy3-preview-free"
    );

    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_assistant_step_finish",
      "ses_open_step_finish",
      1777355829153,
      1777355840500,
      JSON.stringify({
        role: "assistant",
        time: {
          created: 1777355829153,
          completed: 1777355840500
        },
        providerID: "opencode",
        modelID: "hy3-preview-free",
        finish: "stop",
        path: {
          root: "D:/projects/dev/agent-metrics"
        },
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
    );
    db.close();

    await writeFile(
      modelsPath,
      JSON.stringify(
        {
          opencode: {
            api: "https://opencode.ai/zen/v1"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath,
      modelsPath
    });

    const firstPassEvents = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(firstPassEvents.map((event) => event.event_id)).toEqual([
      "opencode:session:ses_open_step_finish:started",
      "opencode:message:msg_assistant_step_finish:assistant"
    ]);

    const reopenDb = new Database(dbPath);
    reopenDb
      .prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "prt_assistant_step_finish_usage",
        "msg_assistant_step_finish",
        "ses_open_step_finish",
        1777355841200,
        1777355841800,
        JSON.stringify({
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
      );
    reopenDb.close();

    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath,
      modelsPath
    });

    const secondPassEvents = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(secondPassEvents.map((event) => event.event_id)).toEqual([
      "opencode:session:ses_open_step_finish:started",
      "opencode:message:msg_assistant_step_finish:assistant",
      "opencode:message:msg_assistant_step_finish:usage"
    ]);
    expect(secondPassEvents[2]).toEqual(
      expect.objectContaining({
        event_id: "opencode:message:msg_assistant_step_finish:usage",
        input_tokens: 220,
        output_tokens: 96,
        cache_read_input_tokens: 5,
        usage_source: "opencode-step-finish",
        provider_host: "opencode.ai"
      })
    );
  });

  it("syncs zcode database rows into the shared opencode event stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-zcode-"));
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "opencode-cursor.json");
    const ledgerPath = join(root, "opencode-ledger.json");
    const zcodeDbPath = join(root, "zcode.sqlite");
    const db = new Database(zcodeDbPath);

    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        path TEXT,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        share_url TEXT,
        summary_additions INTEGER,
        summary_deletions INTEGER,
        summary_files INTEGER,
        summary_diffs TEXT,
        revert TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_compacting INTEGER,
        time_archived INTEGER,
        task_type TEXT NOT NULL DEFAULT 'interactive',
        title_source TEXT NOT NULL DEFAULT 'first_input',
        title_message_id TEXT,
        time_title_updated INTEGER,
        trace_id TEXT
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

    db.prepare(`
      INSERT INTO session (
        id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_compacting, time_archived,
        task_type, title_source, title_message_id, time_title_updated, trace_id
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, 'interactive', 'first_input', NULL, ?, ?)
    `).run(
      "sess_zcode_1",
      "proj_zcode_1",
      "sess_zcode_1",
      "C:/Users/qinyang.li/ZCodeProject",
      "C:/Users/qinyang.li/ZCodeProject",
      "ZCode Demo",
      "0.14.5",
      JSON.stringify({ mode: "yolo" }),
      1777355820000,
      1777355843000,
      1777355820000,
      "trace_zcode_1"
    );

    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_zcode_user",
      "sess_zcode_1",
      1777355820355,
      1777355820355,
      JSON.stringify({
        role: "user",
        time: { created: 1777355820355 }
      })
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "msg_zcode_assistant",
      "sess_zcode_1",
      1777355829153,
      1777355842420,
      JSON.stringify({
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
          input: 27470,
          output: 207,
          reasoning: 0,
          cache: {
            read: 2048,
            write: 0
          }
        }
      })
    );

    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_zcode_user_text",
      "msg_zcode_user",
      "sess_zcode_1",
      1777355820355,
      1777355820355,
      JSON.stringify({
        type: "text",
        text: "把 zcode 数据并入 opencode"
      })
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "prt_zcode_tool_1",
      "msg_zcode_assistant",
      "sess_zcode_1",
      1777355841227,
      1777355841866,
      JSON.stringify({
        type: "tool",
        tool: "Bash",
        state: {
          status: "completed",
          input: {
            command: "git status"
          },
          time: {
            start: 1777355841852,
            end: 1777355841866
          }
        }
      })
    );
    db.close();

    process.env.AGENT_METRICS_OPENCODE_DB_PATH = join(root, "missing-opencode.db");
    process.env.AGENT_METRICS_ZCODE_DB_PATH = zcodeDbPath;
    delete process.env.AGENT_METRICS_ZCODE_MODELS_PATH;

    await syncOpenCodeDatabase({
      eventLogPath,
      cursorPath,
      ledgerPath
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.map((event) => event.event_id)).toEqual([
      "opencode:zcode:session:sess_zcode_1:started",
      "opencode:zcode:message:msg_zcode_user:prompt",
      "opencode:zcode:part:prt_zcode_tool_1:tool:started",
      "opencode:zcode:part:prt_zcode_tool_1:tool:succeeded",
      "opencode:zcode:message:msg_zcode_assistant:assistant",
      "opencode:zcode:message:msg_zcode_assistant:usage"
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: "opencode:zcode:message:msg_zcode_assistant:assistant",
          source_vendor: "opencode",
          source_adapter: "zcode-db",
          provider_id: "builtin:zai-coding-plan"
        }),
        expect.objectContaining({
          event_id: "opencode:zcode:message:msg_zcode_assistant:usage",
          source_vendor: "opencode",
          source_adapter: "zcode-db",
          usage_source: "opencode-message"
        })
      ])
    );

    delete process.env.AGENT_METRICS_OPENCODE_DB_PATH;
    delete process.env.AGENT_METRICS_ZCODE_DB_PATH;
  });
});
