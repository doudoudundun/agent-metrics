# Codex and OpenCode Telemetry Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich OpenCode events with provider host metadata and upgrade Codex local telemetry so the dashboard can credibly show Turns, Tool Calls, and Edit Operations.

**Architecture:** Keep the existing source-aware normalized event model intact. Extend `adapters-opencode` with a local provider registry lookup, extend `adapters-codex` to emit prompt/response/tool/edit events from stable rollout artifacts, and verify the existing core query layer surfaces the richer event stream without changing token accounting semantics.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, Fastify, local JSON/JSONL parsing

---

## File Map

### OpenCode adapter

- Modify: `packages/adapters-opencode/src/opencode.ts`
- Modify: `packages/adapters-opencode/src/opencode-sync.ts`
- Modify: `packages/adapters-opencode/src/opencode.test.ts`
- Modify: `packages/adapters-opencode/src/opencode-sync.test.ts`

Responsibility:

- load a local provider registry from `models.json`
- map `providerID` to `provider_base_url` and `provider_host`
- preserve current session/message/tool extraction behavior

### Codex adapter

- Modify: `packages/adapters-codex/src/codex.ts`
- Modify: `packages/adapters-codex/src/codex.test.ts`
- Modify: `packages/adapters-codex/src/codex-sync.test.ts`

Responsibility:

- map rollout `user_message` and `agent_message` into turns
- map legacy and new-format rollout tool events into normalized tool events
- map successful `patch_apply_end` events into normalized code-edit events

### Core integration verification

- Modify: `apps/core/src/app.test.ts`

Responsibility:

- prove the richer OpenCode and Codex events surface through existing overview, tools, sessions, and timeline APIs
- guard against token regressions and duplicate ingestion

### Verification and docs

- Modify: `docs/superpowers/plans/2026-05-28-codex-opencode-telemetry-detail.md`

Responsibility:

- record any execution-time adjustments inline if the codebase or fixtures force minor contract changes

## Task 1: Enrich OpenCode events with provider host metadata

**Files:**
- Modify: `packages/adapters-opencode/src/opencode.ts`
- Modify: `packages/adapters-opencode/src/opencode-sync.ts`
- Modify: `packages/adapters-opencode/src/opencode.test.ts`
- Modify: `packages/adapters-opencode/src/opencode-sync.test.ts`
- Test: `packages/adapters-opencode/src/opencode.test.ts`
- Test: `packages/adapters-opencode/src/opencode-sync.test.ts`

- [ ] **Step 1: Write the failing unit test for provider registry enrichment**

```ts
it("enriches assistant and usage events with provider host metadata from a local registry", () => {
  const events = normalizeOpenCodeMessageRow({
    row: {
      id: "msg_assistant_1",
      session_id: "ses_open_1",
      time_created: 1779876001153,
      time_updated: 1779876002420,
      data: JSON.stringify({
        role: "assistant",
        time: {
          created: 1779876001153,
          completed: 1779876002420
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
    },
    sessionDirectory: "D:/projects/dev/agent-metrics",
    sessionModel: "hy3-preview-free",
    partRows: [
      {
        id: "prt_assistant_text",
        message_id: "msg_assistant_1",
        session_id: "ses_open_1",
        time_created: 1779876001641,
        time_updated: 1779876001641,
        data: JSON.stringify({
          type: "text",
          text: "Found it."
        })
      }
    ],
    providerRegistry: {
      opencode: {
        baseUrl: "https://opencode.ai/zen/v1",
        host: "opencode.ai"
      }
    }
  });

  expect(events).toEqual([
    expect.objectContaining({
      type: "assistant.responded",
      provider_id: "opencode",
      provider_base_url: "https://opencode.ai/zen/v1",
      provider_host: "opencode.ai"
    }),
    expect.objectContaining({
      type: "token.usage.recorded",
      provider_id: "opencode",
      provider_base_url: "https://opencode.ai/zen/v1",
      provider_host: "opencode.ai"
    })
  ]);
});
```

- [ ] **Step 2: Write the failing sync test for registry loading**

```ts
it("loads provider metadata from models.json during sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-provider-"));
  const dbPath = join(root, "opencode.db");
  const modelsPath = join(root, "models.json");
  const eventLogPath = join(root, "events.jsonl");
  const cursorPath = join(root, "cursor.json");
  const ledgerPath = join(root, "ledger.json");
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
    "prt_assistant_text",
    "msg_assistant_1",
    "ses_open_1",
    1777355840641,
    1777355840641,
    JSON.stringify({
      type: "text",
      text: "Found it."
    })
  );
  db.close();

  await writeFile(
    modelsPath,
    JSON.stringify({
      opencode: {
        id: "opencode",
        api: "https://opencode.ai/zen/v1"
      }
    }),
    "utf8"
  );

  await syncOpenCodeDatabase({
    eventLogPath,
    cursorPath,
    ledgerPath,
    dbPath,
    modelsPath
  });

  const events = (await readFile(eventLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "token.usage.recorded",
      provider_id: "opencode",
      provider_base_url: "https://opencode.ai/zen/v1",
      provider_host: "opencode.ai"
    })
  );
});
```

- [ ] **Step 3: Run the OpenCode adapter tests to verify they fail**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-opencode test
```

Expected:

- FAIL because `normalizeOpenCodeMessageRow` does not accept a provider registry yet
- FAIL because `syncOpenCodeDatabase` does not load `models.json`

- [ ] **Step 4: Implement the provider registry types and event enrichment**

```ts
export type OpenCodeProviderMetadata = {
  baseUrl: string | null;
  host: string | null;
};

export type OpenCodeProviderRegistry = Record<string, OpenCodeProviderMetadata>;

export function normalizeOpenCodeMessageRow(input: {
  row: OpenCodeMessageRow;
  sessionDirectory?: string | null;
  sessionModel?: string | null;
  partRows?: OpenCodePartRow[];
  providerRegistry?: OpenCodeProviderRegistry;
}): AnyEvent[] {
  const parsed = parseJsonRecord(input.row.data);
  if (parsed === null) {
    return [];
  }

  const providerId =
    normalizeOptionalString(parsed.providerID) ??
    normalizeOptionalString(readNestedValue(parsed, "model", "providerID")) ??
    null;
  const providerMetadata =
    providerId !== null ? input.providerRegistry?.[providerId] : undefined;

  return [
    {
      event_id: `opencode:message:${input.row.id}:assistant`,
      session_id: input.row.session_id,
      timestamp: toIsoTimestamp(completedAt),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: OPENCODE_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "assistant.responded",
      message_id: input.row.id,
      model,
      stop_reason: stopReason,
      response_chars: responseChars,
      provider_id: providerId,
      provider_base_url: providerMetadata?.baseUrl ?? null,
      provider_host: providerMetadata?.host ?? null
    },
    {
      event_id: `opencode:message:${input.row.id}:usage`,
      session_id: input.row.session_id,
      timestamp: toIsoTimestamp(completedAt),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: OPENCODE_SOURCE_ADAPTER,
      workspace_path: workspacePath,
      type: "token.usage.recorded",
      message_id: input.row.id,
      model,
      input_tokens: tokenPayload.inputTokens,
      output_tokens: tokenPayload.outputTokens,
      cache_creation_input_tokens: tokenPayload.cacheCreationTokens,
      cache_read_input_tokens: tokenPayload.cacheReadTokens,
      server_tool_use: "{}",
      usage_source: "opencode-message",
      provider_id: providerId,
      provider_base_url: providerMetadata?.baseUrl ?? null,
      provider_host: providerMetadata?.host ?? null
    }
  ];
}
```

- [ ] **Step 5: Implement local registry loading in the sync layer**

```ts
export function resolveDefaultOpenCodeModelsPath(): string {
  return join(homedir(), ".cache", "opencode", "models.json");
}

export async function syncOpenCodeDatabase(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  dbPath?: string;
  modelsPath?: string;
}): Promise<void> {
  const modelsPath =
    input.modelsPath ??
    process.env.AGENT_METRICS_OPENCODE_MODELS_PATH ??
    resolveDefaultOpenCodeModelsPath();
  const providerRegistry = await loadProviderRegistry(modelsPath);

  const events = [
    ...messageRows.flatMap((row) => {
      const session = sessionLookup.get(row.session_id);

      return normalizeOpenCodeMessageRow({
        row,
        sessionDirectory: session?.directory ?? null,
        sessionModel: session?.model ?? null,
        partRows: partRowsByMessageId.get(row.id) ?? [],
        providerRegistry
      });
    })
  ];
}

async function loadProviderRegistry(modelsPath: string): Promise<OpenCodeProviderRegistry> {
  if (!existsSync(modelsPath)) {
    return {};
  }

  const parsed = JSON.parse(await readFile(modelsPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).flatMap(([providerId, value]) => {
      if (!isRecord(value)) {
        return [];
      }

      const baseUrl = typeof value.api === "string" && value.api.length > 0 ? value.api : null;
      return [[providerId, { baseUrl, host: extractHost(baseUrl) }] as const];
    })
  );
}

function extractHost(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 6: Run OpenCode tests to verify they pass**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-opencode test
corepack pnpm --filter @agent-metrics/adapters-opencode build
```

Expected:

- PASS with provider host enrichment covered at both unit and sync levels

- [ ] **Step 7: Commit the OpenCode slice**

```bash
git add packages/adapters-opencode/src/opencode.ts packages/adapters-opencode/src/opencode-sync.ts packages/adapters-opencode/src/opencode.test.ts packages/adapters-opencode/src/opencode-sync.test.ts
git commit -m "feat(opencode): enrich provider host from local registry"
```

## Task 2: Emit Codex turns from stable rollout messages

**Files:**
- Modify: `packages/adapters-codex/src/codex.ts`
- Modify: `packages/adapters-codex/src/codex.test.ts`
- Test: `packages/adapters-codex/src/codex.test.ts`

- [ ] **Step 1: Write the failing Codex turn extraction test**

```ts
it("maps user_message and agent_message rollout events into prompt and response events", () => {
  const events = extractCodexEventsFromRollout({
    filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-2026-05-28T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
    sessionModels: {
      "019e5dc9-b10c-7371-8edd-066e8db7e50d": "gpt-5.4"
    },
    providerConfigs: {
      ai: {
        baseUrl: "https://api.psydo.top",
        host: "api.psydo.top"
      }
    },
    contents: [
      JSON.stringify({
        timestamp: "2026-05-28T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
          timestamp: "2026-05-28T10:00:00.000Z",
          cwd: "D:/projects/dev",
          model_provider: "ai"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Review the changes."
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Reading the diff now.",
          phase: "commentary"
        }
      })
    ].join("\n")
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "prompt.submitted",
      session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
      prompt_chars: 19
    })
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "assistant.responded",
      session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
      model: "gpt-5.4",
      provider_id: "ai",
      provider_host: "api.psydo.top",
      response_chars: 21
    })
  );
});
```

- [ ] **Step 2: Run the Codex adapter tests to verify they fail**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-codex test
```

Expected:

- FAIL because `extractCodexEventsFromRollout` only emits session and token usage events

- [ ] **Step 3: Implement prompt and response extraction from rollout messages**

```ts
if (eventType === "event_msg" && payload !== null && normalizeOptionalString(payload.type) === "user_message") {
  const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
  const promptText = normalizeOptionalString(payload.message) ?? "";

  if (sessionId !== null) {
    events.push({
      event_id: `codex:session:${sessionId}:prompt:${buildEventKey(parsed, payload)}`,
      session_id: sessionId,
      timestamp: normalizeOptionalString(parsed.timestamp) ?? sessionMeta?.timestamp ?? new Date(0).toISOString(),
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: "prompt.submitted",
      prompt_id: `prompt_${buildEventKey(parsed, payload)}`,
      prompt_chars: promptText.length
    });
  }

  continue;
}

if (eventType === "event_msg" && payload !== null && normalizeOptionalString(payload.type) === "agent_message") {
  const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
  const responseText = normalizeOptionalString(payload.message) ?? "";
  const providerId = sessionMeta?.providerId ?? null;
  const providerConfig = providerId ? input.providerConfigs?.[providerId] : undefined;

  if (sessionId !== null) {
    events.push({
      event_id: `codex:session:${sessionId}:response:${buildEventKey(parsed, payload)}`,
      session_id: sessionId,
      timestamp: normalizeOptionalString(parsed.timestamp) ?? sessionMeta?.timestamp ?? new Date(0).toISOString(),
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: "assistant.responded",
      message_id: `response_${buildEventKey(parsed, payload)}`,
      model: input.sessionModels?.[sessionId] ?? null,
      stop_reason: normalizeOptionalString(payload.phase) ?? null,
      response_chars: responseText.length,
      provider_id: providerId,
      provider_base_url: providerConfig?.baseUrl ?? null,
      provider_host: providerConfig?.host ?? null
    });
  }

  continue;
}

function buildEventKey(
  parsed: Record<string, unknown>,
  payload: Record<string, unknown>
): string {
  return (
    normalizeOptionalString(payload.call_id) ??
    normalizeOptionalString(parsed.timestamp)?.replaceAll(/[:.]/gu, "-") ??
    "unknown"
  );
}
```

- [ ] **Step 4: Run the Codex adapter tests to verify they pass**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-codex test
corepack pnpm --filter @agent-metrics/adapters-codex build
```

Expected:

- PASS with non-zero turn extraction covered in the rollout parser tests

- [ ] **Step 5: Commit the Codex turn slice**

```bash
git add packages/adapters-codex/src/codex.ts packages/adapters-codex/src/codex.test.ts
git commit -m "feat(codex): extract turns from rollout messages"
```

## Task 3: Emit Codex tool and edit events from legacy and new rollout formats

**Files:**
- Modify: `packages/adapters-codex/src/codex.ts`
- Modify: `packages/adapters-codex/src/codex.test.ts`
- Modify: `packages/adapters-codex/src/codex-sync.test.ts`
- Test: `packages/adapters-codex/src/codex.test.ts`
- Test: `packages/adapters-codex/src/codex-sync.test.ts`

- [ ] **Step 1: Write the failing legacy and new-format Codex event tests**

```ts
it("maps legacy custom_tool_call rows into normalized tool events", () => {
  const events = extractCodexEventsFromRollout({
    filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-legacy.jsonl",
    contents: [
      JSON.stringify({
        timestamp: "2026-05-28T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "ses_legacy",
          timestamp: "2026-05-28T10:00:00.000Z",
          cwd: "D:/projects/dev",
          model_provider: "ai"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:05.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call_apply_patch_1",
          name: "apply_patch",
          input: "*** Begin Patch\\n*** End Patch\\n"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:06.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_apply_patch_1",
          output: JSON.stringify({
            output: "Success. Updated the following files:\\nM src/app.ts\\n",
            metadata: {
              exit_code: 0,
              duration_seconds: 0.4
            }
          })
        }
      })
    ].join("\n")
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.called",
      tool_name: "apply_patch",
      status: "started"
    })
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.succeeded",
      tool_name: "apply_patch",
      status: "succeeded",
      duration_ms: 400
    })
  );
});

it("maps patch_apply_end and web_search_end into tool and edit events", () => {
  const events = extractCodexEventsFromRollout({
    filePath: "C:/Users/test/.codex/sessions/2026/05/28/rollout-new.jsonl",
    contents: [
      JSON.stringify({
        timestamp: "2026-05-28T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "ses_new",
          timestamp: "2026-05-28T10:00:00.000Z",
          cwd: "D:/projects/dev",
          model_provider: "ai"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:10.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call_patch_1",
          success: true,
          stdout: "Success. Updated the following files:\\nM src/app.ts\\n",
          stderr: "",
          changes: {
            "D:/projects/dev/src/app.ts": {
              type: "update",
              unified_diff: "@@ -1,2 +1,3 @@\\n import x\\n+const y = 1;\\n-old\\n+new\\n"
            }
          }
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:11.000Z",
        type: "event_msg",
        payload: {
          type: "web_search_end",
          call_id: "ws_1",
          query: "codex rollout patch_apply_end",
          action: {
            type: "search",
            query: "codex rollout patch_apply_end"
          }
        }
      })
    ].join("\n")
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.succeeded",
      tool_name: "apply_patch"
    })
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "code.edit.applied",
      tool_name: "apply_patch",
      files_changed: ["D:/projects/dev/src/app.ts"],
      file_count: 1,
      insertions: 2,
      deletions: 1,
      edit_operation_count: 1
    })
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "tool.succeeded",
      tool_name: "WebSearch"
    })
  );
});
```

- [ ] **Step 2: Run the Codex adapter tests to verify they fail**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-codex test
```

Expected:

- FAIL because legacy custom tool calls are ignored
- FAIL because `patch_apply_end` and `web_search_end` are not converted into normalized tool/edit events

- [ ] **Step 3: Implement legacy and new-format tool/event parsing**

```ts
type PendingCodexToolCall = {
  sessionId: string;
  workspacePath: string;
  providerId: string | null;
  timestamp: string;
  toolName: string;
  argumentSummary: string;
};

const pendingToolCalls = new Map<string, PendingCodexToolCall>();

if (eventType === "response_item" && payload !== null && normalizeOptionalString(payload.type) === "custom_tool_call") {
  const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
  const callId = normalizeOptionalString(payload.call_id);
  const toolName = normalizeOptionalString(payload.name) ?? "unknown";

  if (sessionId !== null && callId !== null) {
    pendingToolCalls.set(callId, {
      sessionId,
      workspacePath: sessionMeta?.workspacePath ?? ".",
      providerId: sessionMeta?.providerId ?? null,
      timestamp: normalizeOptionalString(parsed.timestamp) ?? sessionMeta?.timestamp ?? new Date(0).toISOString(),
      toolName,
      argumentSummary: serializeCompactJson(payload.input)
    });
    events.push({
      event_id: `codex:session:${sessionId}:tool:${callId}:started`,
      session_id: sessionId,
      timestamp: normalizeOptionalString(parsed.timestamp) ?? sessionMeta?.timestamp ?? new Date(0).toISOString(),
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: "tool.called",
      tool_name: toolName,
      status: "started",
      argument_summary: serializeCompactJson(payload.input)
    });
  }

  continue;
}

if (eventType === "response_item" && payload !== null && normalizeOptionalString(payload.type) === "custom_tool_call_output") {
  const callId = normalizeOptionalString(payload.call_id);
  const pending = callId ? pendingToolCalls.get(callId) : null;
  const result = parseCustomToolOutput(normalizeOptionalString(payload.output));

  if (pending !== null && callId !== null) {
    events.push({
      event_id: `codex:session:${pending.sessionId}:tool:${callId}:${result.success ? "succeeded" : "failed"}`,
      session_id: pending.sessionId,
      timestamp: normalizeOptionalString(parsed.timestamp) ?? pending.timestamp,
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: pending.workspacePath,
      type: result.success ? "tool.succeeded" : "tool.failed",
      tool_name: pending.toolName,
      status: result.success ? "succeeded" : "failed",
      duration_ms: result.durationMs
    });
  }

  continue;
}

if (eventType === "event_msg" && payload !== null && normalizeOptionalString(payload.type) === "web_search_end") {
  const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
  const callId = normalizeOptionalString(payload.call_id) ?? buildEventKey(parsed, payload);

  if (sessionId !== null) {
    events.push({
      event_id: `codex:session:${sessionId}:web_search:${callId}:tool`,
      session_id: sessionId,
      timestamp: normalizeOptionalString(parsed.timestamp) ?? sessionMeta?.timestamp ?? new Date(0).toISOString(),
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: "tool.succeeded",
      tool_name: "WebSearch",
      status: "succeeded",
      duration_ms: 0
    });
  }

  continue;
}

function parseCustomToolOutput(rawOutput: string | undefined): {
  success: boolean;
  durationMs: number;
} {
  if (!rawOutput) {
    return { success: true, durationMs: 0 };
  }

  try {
    const parsed = JSON.parse(rawOutput) as {
      metadata?: {
        exit_code?: number;
        duration_seconds?: number;
      };
    };
    const exitCode = parsed.metadata?.exit_code ?? 0;
    const durationSeconds = parsed.metadata?.duration_seconds ?? 0;

    return {
      success: exitCode === 0,
      durationMs: Math.round(durationSeconds * 1000)
    };
  } catch {
    return {
      success: !/failed/iu.test(rawOutput),
      durationMs: 0
    };
  }
}

function serializeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
```

- [ ] **Step 4: Implement patch edit extraction and diff counting**

```ts
if (eventType === "event_msg" && payload !== null && normalizeOptionalString(payload.type) === "patch_apply_end") {
  const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
  const callId = normalizeOptionalString(payload.call_id) ?? buildEventKey(parsed, payload);
  const success = payload.success === true;
  const changes = asRecord(payload.changes) ?? {};

  if (sessionId !== null) {
    events.push({
      event_id: `codex:session:${sessionId}:patch:${callId}:tool`,
      session_id: sessionId,
      timestamp: normalizeOptionalString(parsed.timestamp) ?? sessionMeta?.timestamp ?? new Date(0).toISOString(),
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: success ? "tool.succeeded" : "tool.failed",
      tool_name: "apply_patch",
      status: success ? "succeeded" : "failed",
      duration_ms: 0
    });

    if (success) {
      const filesChanged = Object.keys(changes);
      const totals = summarizePatchChanges(changes);

      events.push({
        event_id: `codex:session:${sessionId}:patch:${callId}:edit`,
        session_id: sessionId,
        timestamp: normalizeOptionalString(parsed.timestamp) ?? sessionMeta?.timestamp ?? new Date(0).toISOString(),
        source_vendor: CODEX_SOURCE_VENDOR,
        source_adapter: CODEX_ROLLOUT_ADAPTER,
        workspace_path: sessionMeta?.workspacePath ?? ".",
        type: "code.edit.applied",
        tool_name: "apply_patch",
        files_changed: filesChanged,
        file_count: filesChanged.length,
        insertions: totals.insertions,
        deletions: totals.deletions,
        edit_operation_count: 1
      });
    }
  }

  continue;
}

function countUnifiedDiffLines(diff: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      insertions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { insertions, deletions };
}

function summarizePatchChanges(changes: Record<string, unknown>): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;

  for (const value of Object.values(changes)) {
    if (!asRecord(value)) {
      continue;
    }

    const diff = typeof value.unified_diff === "string" ? value.unified_diff : null;
    if (diff !== null) {
      const counts = countUnifiedDiffLines(diff);
      insertions += counts.insertions;
      deletions += counts.deletions;
      continue;
    }

    if (value.type === "add" && typeof value.content === "string") {
      insertions += value.content.split(/\r?\n/u).length;
    }
  }

  return { insertions, deletions };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
```

- [ ] **Step 5: Extend the sync regression test to assert no duplicate Codex tool/edit rows**

```ts
expect(events).toEqual([
  expect.objectContaining({
    event_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:started",
    type: "session.started"
  }),
  expect.objectContaining({
    type: "prompt.submitted"
  }),
  expect.objectContaining({
    type: "assistant.responded"
  }),
  expect.objectContaining({
    type: "tool.succeeded",
    tool_name: "apply_patch"
  }),
  expect.objectContaining({
    type: "code.edit.applied",
    tool_name: "apply_patch"
  }),
  expect.objectContaining({
    type: "tool.succeeded",
    tool_name: "WebSearch"
  }),
  expect.objectContaining({
    event_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:usage:30321",
    type: "token.usage.recorded"
  })
]);
```

- [ ] **Step 6: Run the Codex adapter tests to verify they pass**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-codex test
corepack pnpm --filter @agent-metrics/adapters-codex build
```

Expected:

- PASS with both legacy and new-format rollout coverage
- PASS with idempotent sync still preserved

- [ ] **Step 7: Commit the Codex tool/edit slice**

```bash
git add packages/adapters-codex/src/codex.ts packages/adapters-codex/src/codex.test.ts packages/adapters-codex/src/codex-sync.test.ts
git commit -m "feat(codex): map rollout tools and patch edits"
```

## Task 4: Verify the richer events through core APIs and local runtime smoke

**Files:**
- Modify: `apps/core/src/app.test.ts`
- Test: `apps/core/src/app.test.ts`

- [ ] **Step 1: Write the failing core integration assertions**

```ts
it("surfaces OpenCode provider host metadata through overview and session rows", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-opencode-core-"));
  const paths = getAgentMetricsPaths(repoRoot);
  const fixture = await createOpenCodeFixture(repoRoot);
  process.env.AGENT_METRICS_OPENCODE_DB_PATH = fixture.dbPath;
  process.env.AGENT_METRICS_OPENCODE_MODELS_PATH = fixture.modelsPath;

  const app = buildApp({
    dbPath,
    eventLogPath: paths.eventLogPath,
    repoRoot,
    ...scopedAppInput
  });

  const sessions = await app.inject({ method: "GET", url: "/api/sessions?mode=lifetime&range=day&sourceVendor=opencode" });

  expect(sessions.json()).toMatchObject({
    rows: [
      expect.objectContaining({
        providerId: "opencode",
        providerHost: "opencode.ai"
      })
    ]
  });
});

it("surfaces Codex turns, tool calls, edit operations, and timeline rows", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-codex-core-"));
  const paths = getAgentMetricsPaths(repoRoot);
  const fixture = await createDetailedCodexFixture(repoRoot);
  process.env.AGENT_METRICS_CODEX_SESSIONS_ROOT = fixture.sessionsRoot;
  process.env.AGENT_METRICS_CODEX_LOGS_DB_PATH = fixture.logsDbPath;
  process.env.AGENT_METRICS_CODEX_CONFIG_PATH = fixture.configPath;

  const app = buildApp({
    dbPath,
    eventLogPath: paths.eventLogPath,
    repoRoot,
    ...scopedAppInput
  });

  const overview = await app.inject({
    method: "GET",
    url: "/api/overview?mode=calendar&range=day&sourceVendor=codex"
  });
  const tools = await app.inject({
    method: "GET",
    url: "/api/tools?mode=calendar&range=day&sourceVendor=codex"
  });
  const session = await app.inject({
    method: "GET",
    url: "/api/sessions/019e5dc9-b10c-7371-8edd-066e8db7e50d"
  });

  expect(overview.json()).toMatchObject({
    turnCount: 1,
    responseCount: 1,
    totalToolCalls: 2,
    successfulExecutions: 2,
    editOperationCount: 1,
    affectedFileCount: 1
  });
  expect(tools.json()).toMatchObject({
    rows: expect.arrayContaining([
      expect.objectContaining({ toolName: "apply_patch" }),
      expect.objectContaining({ toolName: "WebSearch" })
    ])
  });
  expect(session.json()).toMatchObject({
    timeline: expect.arrayContaining([
      expect.objectContaining({ kind: "prompt", sourceVendor: "codex" }),
      expect.objectContaining({ kind: "response", sourceVendor: "codex" }),
      expect.objectContaining({ kind: "tool", toolName: "apply_patch", sourceVendor: "codex" }),
      expect.objectContaining({ kind: "edit", toolName: "apply_patch", sourceVendor: "codex" })
    ])
  });
});
```

- [ ] **Step 2: Run the core tests to verify they fail**

Run:

```bash
corepack pnpm --filter @agent-metrics/core test
```

Expected:

- FAIL because OpenCode provider host is still `null`
- FAIL because Codex overview and timeline are still missing turn/tool/edit rows

- [ ] **Step 3: Update the core fixtures to exercise the richer adapter outputs**

```ts
async function createOpenCodeFixture(root: string): Promise<{
  dbPath: string;
  modelsPath: string;
}> {
  const dbPath = await createOpenCodeFixtureDb(root);
  const modelsPath = join(root, "models.json");

  await writeFile(
    modelsPath,
    JSON.stringify({
      opencode: {
        id: "opencode",
        api: "https://opencode.ai/zen/v1"
      }
    }),
    "utf8"
  );

  return { dbPath, modelsPath };
}

async function createDetailedCodexFixture(root: string): Promise<{
  sessionsRoot: string;
  logsDbPath: string;
  configPath: string;
}> {
  await writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-05-28T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
          timestamp: "2026-05-28T10:00:00.000Z",
          cwd: root,
          model_provider: "ai"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Review the telemetry changes."
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Reading the diff now.",
          phase: "commentary"
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call_patch_1",
          success: true,
          stdout: "Success. Updated the following files:\\nM src/app.ts\\n",
          stderr: "",
          changes: {
            "D:/projects/dev/src/app.ts": {
              type: "update",
              unified_diff: "@@ -1,2 +1,3 @@\\n import x\\n+const y = 1;\\n-old\\n+new\\n"
            }
          }
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:04.000Z",
        type: "event_msg",
        payload: {
          type: "web_search_end",
          call_id: "ws_1",
          query: "codex rollout patch_apply_end",
          action: {
            type: "search",
            query: "codex rollout patch_apply_end"
          }
        }
      }),
      JSON.stringify({
        timestamp: "2026-05-28T10:00:12.000Z",
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

  return { sessionsRoot, logsDbPath, configPath };
}
```

- [ ] **Step 4: Run core tests and package builds to verify the full slice passes**

Run:

```bash
corepack pnpm --filter @agent-metrics/adapters-opencode test
corepack pnpm --filter @agent-metrics/adapters-codex test
corepack pnpm --filter @agent-metrics/core test
corepack pnpm --filter @agent-metrics/adapters-opencode build
corepack pnpm --filter @agent-metrics/adapters-codex build
corepack pnpm --filter @agent-metrics/core build
```

Expected:

- PASS across both adapters and core
- no Codex token regression

- [ ] **Step 5: Smoke-test the running local APIs against real data**

Run:

```bash
powershell -ExecutionPolicy Bypass -File .\start-agent-metrics.ps1 -NoBrowser
powershell -Command "(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:45183/api/overview?mode=lifetime&range=day&sourceVendor=opencode').Content"
powershell -Command "(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:45183/api/overview?mode=calendar&range=day&sourceVendor=codex').Content"
powershell -Command "(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:45183/api/tools?mode=calendar&range=day&sourceVendor=codex').Content"
powershell -Command "(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:45183/api/sessions?mode=calendar&range=day&sourceVendor=codex').Content"
```

Expected:

- `OpenCode` response shows non-null `providerHost` where the local registry supports it
- `Codex` response shows non-zero `turnCount`
- `Codex` tools endpoint includes `apply_patch` and/or `WebSearch` when present in local rollouts
- `Codex` session rows show non-zero edit activity on patch-backed sessions

- [ ] **Step 6: Commit the verified integration slice**

```bash
git add apps/core/src/app.test.ts
git commit -m "test(core): verify detailed Codex and OpenCode telemetry"
```

## Self-Review

Spec coverage check:

- OpenCode provider enrichment: Task 1
- Codex turns from stable rollout messages: Task 2
- Codex tool calls from legacy and new rollout formats: Task 3
- Codex edit operations from `patch_apply_end`: Task 3
- core API verification and local smoke: Task 4

Placeholder scan:

- no `TBD`
- no `TODO`
- no implicit “add tests later” instructions

Type consistency:

- OpenCode provider metadata names stay aligned:
  - `providerRegistry`
  - `provider_base_url`
  - `provider_host`
- Codex tool and edit ids stay aligned:
  - `tool.called`
  - `tool.succeeded`
  - `tool.failed`
  - `code.edit.applied`
