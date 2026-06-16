import { randomUUID } from "node:crypto";
import type { AnyEvent, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

export type ClaudeTranscriptObservation =
  | {
      kind: "prompt_submitted";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      promptId: string;
      promptChars: number;
    }
  | {
      kind: "assistant_responded";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      messageId: string;
      model: string | null;
      stopReason: string | null;
      responseChars: number;
      providerId: string | null;
      providerBaseUrl: string | null;
      providerHost: string | null;
    }
  | {
      kind: "token_usage_recorded";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      messageId: string;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      serverToolUse: string;
      providerId: string | null;
      providerBaseUrl: string | null;
      providerHost: string | null;
    }
  | {
      kind: "tool_called";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      toolUseId: string;
      toolName: string;
      argumentSummary: string;
    }
  | {
      kind: "tool_finished";
      sessionId: string;
      workspacePath: string;
      timestamp: string;
      toolUseId: string;
      toolName: string | null;
      isError: boolean;
      durationMs: number;
    };

export type ClaudeSessionContext = {
  sessionId: string;
  workspacePath: string;
  executionPath: string;
  skillsLoaded: boolean;
  skillNames: string[];
  sourceVendor: SourceVendor;
  sourceAdapter: SourceAdapter;
  updatedAt: string;
};

const CLAUDE_SOURCE_VENDOR: SourceVendor = "claude-code";
const CLAUDE_TRANSCRIPT_ADAPTER: SourceAdapter = "claude-transcript";

export function extractClaudeTranscriptObservations(record: unknown): ClaudeTranscriptObservation[] {
  const row = asRecord(record);
  if (row === null) {
    return [];
  }

  const message = asRecord(row.message);
  if (message === null) {
    return [];
  }

  const sessionId = normalizeOptionalString(row.sessionId ?? row.session_id);
  const workspacePath = normalizeWorkspacePath(row.cwd ?? row.workspace_path);
  const timestamp = normalizeValidTimestamp(row.timestamp);
  if (sessionId === undefined || workspacePath === undefined || timestamp === undefined) {
    return [];
  }

  const rowType = normalizeOptionalString(row.type);
  const role = normalizeOptionalString(message.role);

  if (rowType === "user" || role === "user") {
    const observations: ClaudeTranscriptObservation[] = [];
    const promptText = flattenClaudeContent(message.content);
    const promptId = normalizeOptionalString(row.promptId ?? row.prompt_id ?? row.uuid);

    if (promptId !== undefined) {
      observations.push({
        kind: "prompt_submitted",
        sessionId,
        workspacePath,
        timestamp,
        promptId,
        promptChars: promptText.length
      });
    }

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const blockRecord = asRecord(block);
        if (blockRecord === null) {
          continue;
        }

        if (normalizeOptionalString(blockRecord.type) !== "tool_result") {
          continue;
        }

        const toolUseId = normalizeOptionalString(blockRecord.tool_use_id ?? blockRecord.toolUseId);
        if (toolUseId === undefined) {
          continue;
        }

        observations.push({
          kind: "tool_finished",
          sessionId,
          workspacePath,
          timestamp,
          toolUseId,
          toolName: null,
          isError: blockRecord.is_error === true,
          durationMs: 0
        });
      }
    }

    return observations;
  }

  if (rowType !== "assistant" && role !== "assistant") {
    return [];
  }

  const observations: ClaudeTranscriptObservation[] = [];

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const blockRecord = asRecord(block);
      if (blockRecord === null) {
        continue;
      }

      if (normalizeOptionalString(blockRecord.type) !== "tool_use") {
        continue;
      }

      const toolUseId = normalizeOptionalString(blockRecord.id ?? blockRecord.tool_use_id);
      const toolName = normalizeOptionalString(blockRecord.name);
      if (toolUseId === undefined || toolName === undefined) {
        continue;
      }

      observations.push({
        kind: "tool_called",
        sessionId,
        workspacePath,
        timestamp,
        toolUseId,
        toolName,
        argumentSummary: serializeCompactJson(blockRecord.input ?? {})
      });
    }
  }

  const messageId = normalizeOptionalString(message.id ?? row.message_id);
  const model = normalizeNullableString(message.model ?? row.model);
  const responseText = flattenClaudeContent(message.content);
  const providerMetadata = normalizeProviderMetadata(
    asRecord(message.metadata) ??
      asRecord(message.provider) ??
      asRecord(row.metadata) ??
      asRecord(row.provider)
  );

  if (messageId !== undefined && isTerminalAssistantMessage(message, responseText)) {
    observations.push({
      kind: "assistant_responded",
      sessionId,
      workspacePath,
      timestamp,
      messageId,
      model,
      stopReason: normalizeNullableString(message.stop_reason),
      responseChars: responseText.length,
      providerId: providerMetadata.providerId,
      providerBaseUrl: providerMetadata.providerBaseUrl,
      providerHost: providerMetadata.providerHost
    });
  }

  const usage = asRecord(message.usage);
  const usageCounts = usage === null ? null : normalizeUsageCounts(usage);
  if (messageId !== undefined && usageCounts !== null) {
    observations.push({
      kind: "token_usage_recorded",
      sessionId,
      workspacePath,
      timestamp,
      messageId,
      model,
      inputTokens: usageCounts.inputTokens,
      outputTokens: usageCounts.outputTokens,
      cacheCreationInputTokens: usageCounts.cacheCreationInputTokens,
      cacheReadInputTokens: usageCounts.cacheReadInputTokens,
      serverToolUse: usageCounts.serverToolUse,
      providerId: providerMetadata.providerId,
      providerBaseUrl: providerMetadata.providerBaseUrl,
      providerHost: providerMetadata.providerHost
    });
  }

  return observations;
}

export function extractClaudeTranscriptSessionContext(record: unknown): ClaudeSessionContext | null {
  const row = asRecord(record);
  if (row === null) {
    return null;
  }

  const sessionId = normalizeOptionalString(row.sessionId ?? row.session_id);
  const executionPath = normalizeOptionalString(row.cwd ?? row.execution_path ?? row.workspace_path);
  const updatedAt = normalizeValidTimestamp(row.timestamp);
  if (sessionId === undefined || executionPath === undefined || updatedAt === undefined) {
    return null;
  }

  const workspacePath = normalizeWorkspacePath(executionPath);
  if (workspacePath === undefined) {
    return null;
  }

  const skillNames = extractSkillNamesFromTranscriptRecord(row);

  return {
    sessionId,
    workspacePath,
    executionPath,
    skillsLoaded: skillNames.length > 0 || hasSkillListing(row),
    skillNames,
    sourceVendor: CLAUDE_SOURCE_VENDOR,
    sourceAdapter: CLAUDE_TRANSCRIPT_ADAPTER,
    updatedAt
  };
}

export function normalizeClaudeTranscriptObservation(
  observation: ClaudeTranscriptObservation
): AnyEvent {
  const base = {
    event_id: randomUUID(),
    session_id: observation.sessionId,
    timestamp: observation.timestamp,
    source_vendor: CLAUDE_SOURCE_VENDOR,
    source_adapter: CLAUDE_TRANSCRIPT_ADAPTER,
    workspace_path: observation.workspacePath
  };

  if (observation.kind === "prompt_submitted") {
    return {
      ...base,
      type: "prompt.submitted",
      prompt_id: observation.promptId,
      prompt_chars: observation.promptChars
    };
  }

  if (observation.kind === "assistant_responded") {
    return {
      ...base,
      type: "assistant.responded",
      message_id: observation.messageId,
      model: observation.model,
      stop_reason: observation.stopReason,
      response_chars: observation.responseChars,
      provider_id: observation.providerId,
      provider_base_url: observation.providerBaseUrl,
      provider_host: observation.providerHost
    };
  }

  if (observation.kind === "tool_called") {
    return {
      ...base,
      type: "tool.called",
      tool_name: observation.toolName,
      status: "started",
      argument_summary: observation.argumentSummary
    };
  }

  if (observation.kind === "tool_finished") {
    const toolName = observation.toolName ?? observation.toolUseId;
    if (observation.isError) {
      return {
        ...base,
        type: "tool.failed",
        tool_name: toolName,
        status: "failed",
        duration_ms: observation.durationMs
      };
    }

    return {
      ...base,
      type: "tool.succeeded",
      tool_name: toolName,
      status: "succeeded",
      duration_ms: observation.durationMs
    };
  }

  return {
    ...base,
    type: "token.usage.recorded",
    message_id: observation.messageId,
    model: observation.model,
    input_tokens: observation.inputTokens,
    output_tokens: observation.outputTokens,
    cache_creation_input_tokens: observation.cacheCreationInputTokens,
    cache_read_input_tokens: observation.cacheReadInputTokens,
    server_tool_use: observation.serverToolUse,
    usage_source: "claude-transcript",
    provider_id: observation.providerId,
    provider_base_url: observation.providerBaseUrl,
    provider_host: observation.providerHost
  };
}

function normalizeProviderMetadata(provider: Record<string, unknown> | null): {
  providerId: string | null;
  providerBaseUrl: string | null;
  providerHost: string | null;
} {
  const providerId = normalizeNullableString(provider?.id ?? provider?.provider_id ?? provider?.name);
  const providerBaseUrl = normalizeNullableUrl(
    provider?.base_url ?? provider?.baseUrl ?? provider?.url ?? provider?.endpoint
  );
  const providerHost =
    providerBaseUrl === null ? normalizeNullableString(provider?.host ?? provider?.provider_host) : extractHost(providerBaseUrl);

  return {
    providerId,
    providerBaseUrl,
    providerHost
  };
}

function isTerminalAssistantMessage(message: Record<string, unknown>, responseText: string): boolean {
  const stopReason = normalizeOptionalString(message.stop_reason);
  if (stopReason === undefined) {
    return false;
  }

  return isTerminalStopReason(stopReason) && responseText.length > 0;
}

function flattenClaudeContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => flattenClaudeContentEntry(entry))
    .filter((entry) => entry.length > 0)
    .join("\n");
}

function flattenClaudeContentEntry(entry: unknown): string {
  if (typeof entry === "string") {
    return entry;
  }

  const block = asRecord(entry);
  if (block === null) {
    return "";
  }

  if (typeof block.text === "string") {
    return block.text;
  }

  if (typeof block.content === "string") {
    return block.content;
  }

  if (Array.isArray(block.content)) {
    return flattenClaudeContent(block.content);
  }

  return "";
}

function serializeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeWorkspacePath(value: unknown): string | undefined {
  const executionPath = normalizeOptionalString(value);
  if (executionPath === undefined) {
    return undefined;
  }

  return deriveWorkspacePath(executionPath);
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeValidTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

function normalizeNullableUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function extractHost(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function isTerminalStopReason(stopReason: string): boolean {
  return stopReason === "end_turn" || stopReason === "stop_sequence" || stopReason === "max_tokens";
}

function deriveWorkspacePath(executionPath: string): string {
  const trimmed = executionPath.replace(/[/\\]+$/u, "");
  const match = /^(.*?)([/\\])\.claude\2tmp$/iu.exec(trimmed);

  if (match?.[1] && match[1].length > 0) {
    return match[1];
  }

  return trimmed.length > 0 ? trimmed : executionPath;
}

function extractSkillNamesFromTranscriptRecord(record: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  collectSkillNames(record, seen);
  return [...seen];
}

function collectSkillNames(value: unknown, seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSkillNames(entry, seen);
    }
    return;
  }

  const record = asRecord(value);
  if (record === null) {
    return;
  }

  if (normalizeOptionalString(record.type) === "skill_listing") {
    addSkillNamesFromListing(record.skills ?? record.skill_names ?? record.entries ?? record.items, seen);
  }

  for (const entry of Object.values(record)) {
    collectSkillNames(entry, seen);
  }
}

function addSkillNamesFromListing(value: unknown, seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) {
        seen.add(entry);
        continue;
      }

      const record = asRecord(entry);
      const name =
        normalizeOptionalString(record?.name) ??
        normalizeOptionalString(record?.id) ??
        normalizeOptionalString(record?.title);

      if (name) {
        seen.add(name);
      }
    }
  }
}

function hasSkillListing(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasSkillListing(entry));
  }

  const record = asRecord(value);
  if (record === null) {
    return false;
  }

  if (normalizeOptionalString(record.type) === "skill_listing") {
    return true;
  }

  return Object.values(record).some((entry) => hasSkillListing(entry));
}

function normalizeUsageCounts(usage: Record<string, unknown>):
  | {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      serverToolUse: string;
    }
  | null {
  const inputTokens = normalizeNonNegativeInteger(usage.input_tokens);
  const outputTokens = normalizeNonNegativeInteger(usage.output_tokens);
  const cacheCreationInputTokens = normalizeNonNegativeInteger(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = normalizeNonNegativeInteger(usage.cache_read_input_tokens);

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheCreationInputTokens === undefined ||
    cacheReadInputTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    serverToolUse: serializeCompactJson(usage.server_tool_use)
  };
}
