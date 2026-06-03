import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { syncCursorArtifacts } from "./cursor-sync.js";

describe("syncCursorArtifacts", () => {
  it("syncs Cursor composer, prompt, generation, usage, and edit data into normalized events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-cursor-"));
    const trackingDbPath = join(root, "ai-code-tracking.db");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const workspaceId = "ws_1";
    const workspaceStorageDbPath = join(workspaceStorageRoot, workspaceId, "state.vscdb");
    const storageJsonPath = join(root, "storage.json");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor-ide-state.json");
    const ledgerPath = join(root, "cursor-ide-ledger.json");
    const workspacePath = "/Users/test/dev/agent-metrics";
    const createdAt = 1777482580633;
    const promptAt = 1777482581633;
    const responseAt = 1777482582633;

    const trackingDb = new Database(trackingDbPath);
    trackingDb.exec(`
      CREATE TABLE conversation_summaries (
        conversationId TEXT PRIMARY KEY,
        title TEXT,
        tldr TEXT,
        overview TEXT,
        summaryBullets TEXT,
        model TEXT,
        mode TEXT,
        updatedAt INTEGER NOT NULL
      );
    `);
    trackingDb
      .prepare(
        `INSERT INTO conversation_summaries (
          conversationId, title, tldr, overview, summaryBullets, model, mode, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "cmp_1",
        "Refactor parser",
        "Parser updates",
        "Updated the parser flow",
        JSON.stringify(["Added tests", "Refined sync behavior"]),
        "cursor-fast",
        "agent",
        responseAt
      );
    trackingDb.close();

    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    const workspaceDb = new Database(workspaceStorageDbPath);
    workspaceDb.exec(`
      CREATE TABLE ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    workspaceDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "composer.composerData",
        JSON.stringify({
          allComposers: [
            {
              composerId: "cmp_1",
              createdAt,
              totalLinesAdded: 12,
              totalLinesRemoved: 4,
              filesChangedCount: 2,
              unifiedMode: "agent",
              isArchived: false
            }
          ]
        })
      );
    workspaceDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "aiService.prompts",
        JSON.stringify([
          {
            promptId: "prompt_1",
            composerId: "cmp_1",
            createdAt: promptAt,
            text: "Refactor the parser to support background transcripts."
          }
        ])
      );
    workspaceDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "aiService.generations",
        JSON.stringify([
          {
            messageId: "msg_1",
            composerId: "cmp_1",
            createdAt: responseAt,
            text: "Done. I added transcript discovery and tests.",
            model: "cursor-fast",
            usage: {
              inputTokens: 20,
              outputTokens: 5,
              cacheReadInputTokens: 2,
              cacheCreationInputTokens: 0
            }
          }
        ])
      );
    workspaceDb.close();

    await writeFile(
      storageJsonPath,
      JSON.stringify(
        {
          backupWorkspaces: {
            folders: [
              {
                folderUri: `file://${workspacePath}`,
                backupFolder: workspaceId
              }
            ],
            workspaces: [],
            emptyWindows: []
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await syncCursorArtifacts({
      trackingDbPath,
      workspaceStorageRoot,
      storageJsonPath,
      eventLogPath,
      cursorPath,
      ledgerPath
    });
    await syncCursorArtifacts({
      trackingDbPath,
      workspaceStorageRoot,
      storageJsonPath,
      eventLogPath,
      cursorPath,
      ledgerPath
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.map((event) => event.event_id)).toEqual([
      "cursor:session:cmp_1:started",
      "cursor:prompt:prompt_1",
      "cursor:assistant:msg_1",
      "cursor:usage:msg_1",
      `cursor:edit:cmp_1:${createdAt}`
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: "cursor:session:cmp_1:started",
          source_vendor: "cursor",
          source_adapter: "cursor-ide",
          workspace_path: workspacePath,
          type: "session.started"
        }),
        expect.objectContaining({
          event_id: "cursor:usage:msg_1",
          type: "token.usage.recorded",
          model: "cursor-fast",
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 0,
          usage_source: "cursor-generation"
        }),
        expect.objectContaining({
          event_id: `cursor:edit:cmp_1:${createdAt}`,
          type: "code.edit.applied",
          tool_name: "Composer",
          file_count: 2,
          insertions: 12,
          deletions: 4,
          edit_operation_count: 1
        })
      ])
    );
  });

  it("normalizes Windows file URIs from Cursor workspace storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-cursor-win-"));
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const workspaceId = "ws_windows";
    const workspaceStorageDbPath = join(workspaceStorageRoot, workspaceId, "state.vscdb");
    const storageJsonPath = join(root, "storage.json");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor-ide-state.json");
    const ledgerPath = join(root, "cursor-ide-ledger.json");
    const workspacePath = "C:/Users/test/dev/agent-metrics";
    const createdAt = 1777482580633;

    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    const workspaceDb = new Database(workspaceStorageDbPath);
    workspaceDb.exec(`
      CREATE TABLE ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    workspaceDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "composer.composerData",
        JSON.stringify({
          allComposers: [
            {
              composerId: "cmp_win_1",
              createdAt,
              totalLinesAdded: 3,
              totalLinesRemoved: 1,
              filesChangedCount: 1
            }
          ]
        })
      );
    workspaceDb.close();

    await writeFile(
      storageJsonPath,
      JSON.stringify(
        {
          backupWorkspaces: {
            folders: [
              {
                folderUri: "file:///C%3A/Users/test/dev/agent-metrics",
                backupFolder: workspaceId
              }
            ],
            workspaces: [],
            emptyWindows: []
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await syncCursorArtifacts({
      workspaceStorageRoot,
      storageJsonPath,
      eventLogPath,
      cursorPath,
      ledgerPath
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: "cursor:session:cmp_win_1:started",
          workspace_path: workspacePath
        }),
        expect.objectContaining({
          event_id: `cursor:edit:cmp_win_1:${createdAt}`,
          workspace_path: workspacePath
        })
      ])
    );
  });
});
