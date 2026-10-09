import { resolveDisplayedInputTokens } from "@agent-metrics/metrics-engine";
import type { FastifyInstance } from "fastify";
import { parseFilesChanged } from "./query-support.js";
import type { MetricsDatabase } from "./core-types.js";

type SessionRow = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  workspacePath: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type SessionContextRow = {
  executionPath: string | null;
  skillsLoaded: number;
  skillNamesJson: string;
};

type ToolTimelineRow = {
  toolName: string;
  status: string;
  durationMs: number | null;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type CodeEditTimelineRow = {
  toolName: string;
  filesChanged: string;
  insertions: number;
  deletions: number;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type PromptTimelineRow = {
  promptId: string;
  promptChars: number;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
};

type AssistantTimelineRow = {
  messageId: string;
  model: string | null;
  stopReason: string | null;
  responseChars: number;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
};

type TokenUsageTimelineRow = {
  messageId: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usageSource: string;
  createdAt: string;
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
};

type SessionTimelineEntry = {
  createdAt: string;
  type: string;
  toolName: string;
  status: string;
  durationMs: number;
  sourceVendor: string;
  sourceAdapter: string;
  providerId: string | null;
  providerHost: string | null;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  promptId: string | null;
  promptChars: number | null;
  messageId: string | null;
  model: string | null;
  stopReason: string | null;
  responseChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  usageSource: string | null;
};

function createTimelineEntry(
  input: Omit<
    SessionTimelineEntry,
    | "sourceVendor"
    | "sourceAdapter"
    | "providerId"
    | "providerHost"
    | "promptId"
    | "promptChars"
    | "messageId"
    | "model"
    | "stopReason"
    | "responseChars"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheCreationTokens"
    | "totalTokens"
    | "usageSource"
  > &
    Partial<
      Pick<
        SessionTimelineEntry,
        | "sourceVendor"
        | "sourceAdapter"
        | "providerId"
        | "providerHost"
        | "promptId"
        | "promptChars"
        | "messageId"
        | "model"
        | "stopReason"
        | "responseChars"
        | "inputTokens"
        | "outputTokens"
        | "cacheReadTokens"
        | "cacheCreationTokens"
        | "totalTokens"
        | "usageSource"
      >
    >
): SessionTimelineEntry {
  return {
    sourceVendor: "claude-code",
    sourceAdapter: "claude-hook",
    providerId: null,
    providerHost: null,
    promptId: null,
    promptChars: null,
    messageId: null,
    model: null,
    stopReason: null,
    responseChars: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    totalTokens: null,
    usageSource: null,
    ...input
  };
}

export function registerLegacyRoutes({
  app,
  db
}: {
  app: FastifyInstance;
  db: MetricsDatabase;
}): void {
  app.get("/api/sessions/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const session = db
      .prepare<SessionRow>(
        "SELECT session_id AS sessionId, started_at AS startedAt, ended_at AS endedAt, workspace_path AS workspacePath, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM sessions WHERE session_id = ?"
      )
      .get(params.id);

    if (!session) {
      reply.code(404);
      return { message: "Session not found" };
    }

    const sessionContext = db
      .prepare<SessionContextRow>(
        "SELECT execution_path AS executionPath, skills_loaded AS skillsLoaded, skill_names_json AS skillNamesJson FROM session_contexts WHERE session_id = ?"
      )
      .get(params.id);

    const toolRows = db
      .prepare<ToolTimelineRow>(
        "SELECT tool_name AS toolName, status, duration_ms AS durationMs, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM tool_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const promptRows = db
      .prepare<PromptTimelineRow>(
        "SELECT prompt_id AS promptId, prompt_chars AS promptChars, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM prompt_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const assistantRows = db
      .prepare<AssistantTimelineRow>(
        "SELECT message_id AS messageId, model, stop_reason AS stopReason, response_chars AS responseChars, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter, provider_id AS providerId, provider_host AS providerHost FROM assistant_responses WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const tokenUsageRows = db
      .prepare<TokenUsageTimelineRow>(
        "SELECT message_id AS messageId, model, input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_input_tokens AS cacheReadTokens, cache_creation_input_tokens AS cacheCreationTokens, usage_source AS usageSource, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter, provider_id AS providerId, provider_host AS providerHost FROM token_usage_events WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);
    const codeEditRows = db
      .prepare<CodeEditTimelineRow>(
        "SELECT tool_name AS toolName, files_changed AS filesChanged, insertions, deletions, created_at AS createdAt, source_vendor AS sourceVendor, source_adapter AS sourceAdapter FROM code_edits WHERE session_id = ? ORDER BY created_at ASC"
      )
      .all(params.id);

    const timeline: SessionTimelineEntry[] = [
      createTimelineEntry({
        createdAt: session.startedAt,
        type: "session.started",
        toolName: "",
        status: "started",
        durationMs: 0,
        sourceVendor: session.sourceVendor,
        sourceAdapter: session.sourceAdapter,
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0
      }),
      ...promptRows.map((row) =>
        createTimelineEntry({
          createdAt: row.createdAt,
          type: "prompt.submitted",
          toolName: "",
          status: "submitted",
          durationMs: 0,
          sourceVendor: row.sourceVendor,
          sourceAdapter: row.sourceAdapter,
          providerId: null,
          providerHost: null,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          promptId: row.promptId,
          promptChars: row.promptChars
        })
      ),
      ...toolRows.map((row) =>
        createTimelineEntry({
        createdAt: row.createdAt,
        type: `tool.${row.status}`,
        toolName: row.toolName,
        status: row.status,
        durationMs: row.durationMs ?? 0,
        sourceVendor: row.sourceVendor,
        sourceAdapter: row.sourceAdapter,
        providerId: null,
        providerHost: null,
        filesChanged: [],
        insertions: 0,
        deletions: 0
        })
      ),
      ...assistantRows.map((row) =>
        createTimelineEntry({
          createdAt: row.createdAt,
          type: "assistant.responded",
          toolName: "",
          status: "responded",
          durationMs: 0,
          sourceVendor: row.sourceVendor,
          sourceAdapter: row.sourceAdapter,
          providerId: row.providerId,
          providerHost: row.providerHost,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          messageId: row.messageId,
          model: row.model,
          stopReason: row.stopReason,
          responseChars: row.responseChars
        })
      ),
      ...tokenUsageRows.map((row) =>
        createTimelineEntry({
          createdAt: row.createdAt,
          type: "token.usage.recorded",
          toolName: "",
          status: "recorded",
          durationMs: 0,
          sourceVendor: row.sourceVendor,
          sourceAdapter: row.sourceAdapter,
          providerId: row.providerId,
          providerHost: row.providerHost,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
          messageId: row.messageId,
          model: row.model ?? "unknown",
          inputTokens: resolveDisplayedInputTokens({
            source_vendor: row.sourceVendor,
            usage_source: row.usageSource,
            input_tokens: row.inputTokens,
            output_tokens: row.outputTokens,
            cache_creation_input_tokens: row.cacheCreationTokens,
            cache_read_input_tokens: row.cacheReadTokens
          }),
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          totalTokens:
            resolveDisplayedInputTokens({
              source_vendor: row.sourceVendor,
              usage_source: row.usageSource,
              input_tokens: row.inputTokens,
              output_tokens: row.outputTokens,
              cache_creation_input_tokens: row.cacheCreationTokens,
              cache_read_input_tokens: row.cacheReadTokens
            }) +
            row.outputTokens +
            row.cacheReadTokens +
            row.cacheCreationTokens,
          usageSource: row.usageSource
        })
      ),
      ...codeEditRows.map((row) =>
        createTimelineEntry({
        createdAt: row.createdAt,
        type: "code.edit.applied",
        toolName: row.toolName,
        status: "applied",
        durationMs: 0,
        sourceVendor: row.sourceVendor,
        sourceAdapter: row.sourceAdapter,
        providerId: null,
        providerHost: null,
        filesChanged: parseFilesChanged(row.filesChanged),
        insertions: row.insertions,
        deletions: row.deletions
        })
      ),
      ...(session.endedAt
        ? [
            createTimelineEntry({
              createdAt: session.endedAt,
              type: "session.ended",
              toolName: "",
              status: "ended",
              durationMs: 0,
              sourceVendor: session.sourceVendor,
              sourceAdapter: session.sourceAdapter,
              providerId: null,
              providerHost: null,
              filesChanged: [],
              insertions: 0,
              deletions: 0
            })
          ]
        : [])
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return {
      sessionId: params.id,
      workspacePath: session.workspacePath,
      sourceVendor: session.sourceVendor,
      sourceAdapter: session.sourceAdapter,
      context: sessionContext
        ? {
            executionPath: sessionContext.executionPath,
            skillsLoaded: sessionContext.skillsLoaded === 1,
            skillNames: parseFilesChanged(sessionContext.skillNamesJson)
          }
        : null,
      timeline
    };
  });
}

