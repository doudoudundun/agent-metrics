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

  it("falls back to ai_code_hashes when Cursor workspace data no longer includes session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-cursor-hashes-"));
    const trackingDbPath = join(root, "ai-code-tracking.db");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const workspaceId = "ws_hash";
    const workspaceStorageDbPath = join(workspaceStorageRoot, workspaceId, "state.vscdb");
    const storageJsonPath = join(root, "storage.json");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor-ide-state.json");
    const ledgerPath = join(root, "cursor-ide-ledger.json");
    const startedAt = 1777482580633;
    const completedAt = 1777482582633;

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
      CREATE TABLE ai_code_hashes (
        hash TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        fileExtension TEXT,
        fileName TEXT,
        requestId TEXT,
        conversationId TEXT,
        timestamp INTEGER,
        model TEXT,
        createdAt INTEGER NOT NULL
      );
    `);
    trackingDb
      .prepare(
        `INSERT INTO ai_code_hashes (
          hash, source, fileExtension, fileName, requestId, conversationId, timestamp, model, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "hash_1",
        "composer",
        "ts",
        "/D:/projects/dev/agent-metrics/apps/desktop/src/main.ts",
        "req_hash_1",
        "conv_hash_1",
        startedAt,
        "composer-2.5",
        startedAt
      );
    trackingDb
      .prepare(
        `INSERT INTO ai_code_hashes (
          hash, source, fileExtension, fileName, requestId, conversationId, timestamp, model, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "hash_2",
        "composer",
        "tsx",
        "/D:/projects/dev/agent-metrics/apps/dashboard/src/App.tsx",
        "req_hash_1",
        "conv_hash_1",
        completedAt,
        "composer-2.5",
        completedAt
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
          selectedComposerIds: ["conv_hash_1"],
          lastFocusedComposerIds: ["conv_hash_1"],
          hasMigratedComposerData: true
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
                folderUri: "file:///D%3A/projects/dev/agent-metrics",
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

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: "cursor:session:conv_hash_1:started",
          type: "session.started",
          workspace_path: "D:/projects/dev/agent-metrics/apps"
        }),
        expect.objectContaining({
          event_id: "cursor:tool:conv_hash_1:req_hash_1:started",
          type: "tool.called",
          tool_name: "Composer"
        }),
        expect.objectContaining({
          event_id: "cursor:tool:conv_hash_1:req_hash_1:succeeded",
          type: "tool.succeeded",
          tool_name: "Composer",
          duration_ms: completedAt - startedAt
        }),
        expect.objectContaining({
          event_id: "cursor:edit:conv_hash_1:req_hash_1",
          type: "code.edit.applied",
          file_count: 2,
          workspace_path: "D:/projects/dev/agent-metrics/apps",
          files_changed: [
            "D:/projects/dev/agent-metrics/apps/desktop/src/main.ts",
            "D:/projects/dev/agent-metrics/apps/dashboard/src/App.tsx"
          ]
        })
      ])
    );
  });

  it("hydrates migrated Cursor sessions from global composer headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-cursor-global-"));
    const trackingDbPath = join(root, "missing-tracking.db");
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const globalStorageRoot = join(root, "globalStorage");
    const workspaceId = "ws_global";
    const workspaceStorageDbPath = join(workspaceStorageRoot, workspaceId, "state.vscdb");
    const globalStorageDbPath = join(globalStorageRoot, "state.vscdb");
    const storageJsonPath = join(globalStorageRoot, "storage.json");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor-ide-state.json");
    const ledgerPath = join(root, "cursor-ide-ledger.json");
    const createdAt = 1780920034799;
    const updatedAt = 1780920061809;

    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    await mkdir(globalStorageRoot, { recursive: true });

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
          selectedComposerIds: ["cmp_global_1"],
          lastFocusedComposerIds: ["cmp_global_1"],
          hasMigratedComposerData: true
        })
      );
    workspaceDb.close();

    const globalDb = new Database(globalStorageDbPath);
    globalDb.exec(`
      CREATE TABLE ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    globalDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "composer.composerHeaders",
        JSON.stringify({
          allComposers: [
            {
              composerId: "cmp_global_1",
              createdAt,
              lastUpdatedAt: updatedAt,
              conversationCheckpointLastUpdatedAt: updatedAt,
              totalLinesAdded: 8,
              totalLinesRemoved: 3,
              filesChangedCount: 2,
              workspaceIdentifier: {
                id: workspaceId,
                uri: {
                  fsPath: "D:\\projects\\dev\\agent-metrics",
                  external: "file:///D%3A/projects/dev/agent-metrics"
                }
              }
            }
          ]
        })
      );
    globalDb.close();

    await writeFile(
      storageJsonPath,
      JSON.stringify(
        {
          backupWorkspaces: {
            folders: [
              {
                folderUri: "file:///D%3A/projects/dev/agent-metrics",
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
      globalStorageDbPath,
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
          event_id: "cursor:session:cmp_global_1:started",
          type: "session.started",
          workspace_path: "D:/projects/dev/agent-metrics",
          timestamp: new Date(createdAt).toISOString()
        }),
        expect.objectContaining({
          event_id: `cursor:edit:cmp_global_1:${createdAt}`,
          type: "code.edit.applied",
          file_count: 2,
          insertions: 8,
          deletions: 3,
          workspace_path: "D:/projects/dev/agent-metrics",
          timestamp: new Date(updatedAt).toISOString()
        })
      ])
    );
  });

  it("hydrates prompt and response events from Cursor agent transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-cursor-transcript-"));
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const globalStorageRoot = join(root, "globalStorage");
    const cursorProjectsRoot = join(root, "cursor-projects");
    const workspaceId = "ws_transcript";
    const sessionId = "cmp_transcript_1";
    const workspaceStorageDbPath = join(workspaceStorageRoot, workspaceId, "state.vscdb");
    const globalStorageDbPath = join(globalStorageRoot, "state.vscdb");
    const storageJsonPath = join(globalStorageRoot, "storage.json");
    const transcriptDir = join(
      cursorProjectsRoot,
      "d-projects-dev-agent-metrics",
      "agent-transcripts",
      sessionId
    );
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor-ide-state.json");
    const ledgerPath = join(root, "cursor-ide-ledger.json");
    const createdAt = 1780920034799;
    const updatedAt = 1780920061809;
    const promptText = "当前我桌面版的悬浮球，无法拖拽，点击，右键，这个功能有问题";
    const assistantText = "我先排查桌面端悬浮球的事件链路。";

    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    await mkdir(globalStorageRoot, { recursive: true });
    await mkdir(transcriptDir, { recursive: true });

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
          selectedComposerIds: [sessionId],
          lastFocusedComposerIds: [sessionId],
          hasMigratedComposerData: true
        })
      );
    workspaceDb.close();

    const globalDb = new Database(globalStorageDbPath);
    globalDb.exec(`
      CREATE TABLE ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    globalDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "composer.composerHeaders",
        JSON.stringify({
          allComposers: [
            {
              composerId: sessionId,
              createdAt,
              lastUpdatedAt: updatedAt,
              workspaceIdentifier: {
                id: workspaceId,
                uri: {
                  fsPath: "D:\\projects\\dev\\agent-metrics",
                  external: "file:///D%3A/projects/dev/agent-metrics"
                }
              }
            }
          ]
        })
      );
    globalDb.close();

    await writeFile(
      storageJsonPath,
      JSON.stringify(
        {
          backupWorkspaces: {
            folders: [
              {
                folderUri: "file:///D%3A/projects/dev/agent-metrics",
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

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: `<timestamp>Monday, Jun 8, 2026, 11:41 AM (UTC+8)</timestamp>\n<user_query>\n${promptText}\n</user_query>`
              }
            ]
          }
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: assistantText
              },
              {
                type: "tool_use",
                name: "Read",
                input: {
                  path: "D:\\projects\\dev\\agent-metrics\\apps\\desktop\\src\\main.ts"
                }
              }
            ]
          }
        }),
        JSON.stringify({
          type: "turn_ended",
          status: "success"
        })
      ].join("\n"),
      "utf8"
    );

    const trackingDbPath = join(root, "missing-tracking.db");
    const syncInput = {
      trackingDbPath,
      workspaceStorageRoot,
      storageJsonPath,
      globalStorageDbPath,
      eventLogPath,
      cursorPath,
      ledgerPath,
      cursorProjectsRoot
    };

    await syncCursorArtifacts(syncInput as Parameters<typeof syncCursorArtifacts>[0]);

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: "cursor:prompt:transcript:cmp_transcript_1:1",
          type: "prompt.submitted",
          session_id: sessionId,
          workspace_path: "D:/projects/dev/agent-metrics",
          prompt_chars: promptText.length
        }),
        expect.objectContaining({
          event_id: "cursor:assistant:transcript:cmp_transcript_1:2",
          type: "assistant.responded",
          session_id: sessionId,
          workspace_path: "D:/projects/dev/agent-metrics",
          response_chars: assistantText.length
        })
      ])
    );
  });

  it("falls back to composerData context token usage when Cursor generation usage is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-cursor-context-"));
    const workspaceStorageRoot = join(root, "workspaceStorage");
    const globalStorageRoot = join(root, "globalStorage");
    const workspaceId = "ws_context";
    const sessionId = "cmp_context_1";
    const workspaceStorageDbPath = join(workspaceStorageRoot, workspaceId, "state.vscdb");
    const globalStorageDbPath = join(globalStorageRoot, "state.vscdb");
    const storageJsonPath = join(globalStorageRoot, "storage.json");
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor-ide-state.json");
    const ledgerPath = join(root, "cursor-ide-ledger.json");
    const createdAt = 1780920034799;
    const promptAt = 1780920040000;
    const responseAt = 1780920061809;

    await mkdir(join(workspaceStorageRoot, workspaceId), { recursive: true });
    await mkdir(globalStorageRoot, { recursive: true });

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
              composerId: sessionId,
              createdAt,
              totalLinesAdded: 3,
              totalLinesRemoved: 1,
              filesChangedCount: 1
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
            promptId: "prompt_context_1",
            composerId: sessionId,
            createdAt: promptAt,
            text: "Check the refreshed Cursor token pipeline."
          }
        ])
      );
    workspaceDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "aiService.generations",
        JSON.stringify([
          {
            messageId: "msg_context_1",
            composerId: sessionId,
            createdAt: responseAt,
            text: "I inspected the latest Cursor storage chain.",
            model: "cursor-max"
          }
        ])
      );
    workspaceDb.close();

    const globalDb = new Database(globalStorageDbPath);
    globalDb.exec(`
      CREATE TABLE ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE cursorDiskKV (
        key TEXT PRIMARY KEY,
        value BLOB
      );
    `);
    globalDb
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(
        "composer.composerHeaders",
        JSON.stringify({
          allComposers: [
            {
              composerId: sessionId,
              createdAt,
              lastUpdatedAt: responseAt,
              workspaceIdentifier: {
                id: workspaceId,
                uri: {
                  fsPath: "D:\\projects\\dev\\agent-metrics",
                  external: "file:///D%3A/projects/dev/agent-metrics"
                }
              }
            }
          ]
        })
      );
    globalDb
      .prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
      .run(
        `composerData:${sessionId}`,
        JSON.stringify({
          composerId: sessionId,
          createdAt,
          lastUpdatedAt: responseAt,
          status: "completed",
          contextTokensUsed: 4096,
          contextTokenLimit: 200000,
          promptTokenBreakdown: {
            totalUsedTokens: 4096,
            maxTokens: 200000,
            categories: [
              {
                id: "conversation",
                label: "Conversation",
                estimatedTokens: 4096
              }
            ]
          },
          fullConversationHeadersOnly: [
            {
              bubbleId: "bubble_context_user",
              type: 1
            },
            {
              bubbleId: "bubble_context_assistant",
              type: 2,
              grouping: {
                isRenderable: true,
                hasText: true,
                turnDurationMs: 1200
              }
            }
          ]
        })
      );
    globalDb.close();

    await writeFile(
      storageJsonPath,
      JSON.stringify(
        {
          backupWorkspaces: {
            folders: [
              {
                folderUri: "file:///D%3A/projects/dev/agent-metrics",
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
      trackingDbPath: join(root, "missing-tracking.db"),
      workspaceStorageRoot,
      storageJsonPath,
      globalStorageDbPath,
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
          event_id: "cursor:assistant:msg_context_1",
          type: "assistant.responded",
          model: "cursor-max",
          session_id: sessionId
        }),
        expect.objectContaining({
          event_id: "cursor:usage:msg_context_1",
          type: "token.usage.recorded",
          model: "cursor-max",
          session_id: sessionId,
          input_tokens: 4096,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          usage_source: "cursor-composer-context"
        })
      ])
    );
  });
});
