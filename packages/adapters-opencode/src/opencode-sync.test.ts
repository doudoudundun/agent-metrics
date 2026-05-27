import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { syncOpenCodeDatabase } from "./opencode-sync.js";

describe("syncOpenCodeDatabase", () => {
  it("syncs OpenCode rows into normalized events and dedupes reruns", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-"));
    const dbPath = join(root, "opencode.db");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "opencode-cursor.json");
    const ledgerPath = join(root, "opencode-ledger.json");
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

    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath
    });
    await syncOpenCodeDatabase({
      dbPath,
      eventLogPath,
      cursorPath,
      ledgerPath
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
  });
});
