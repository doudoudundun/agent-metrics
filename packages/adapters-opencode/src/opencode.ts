import type { AnyEvent, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

const OPENCODE_SOURCE_VENDOR: SourceVendor = "opencode";
const OPENCODE_SOURCE_ADAPTER: SourceAdapter = "opencode-db";

export type OpenCodeSessionRow = {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
};

export type OpenCodeMessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

export type OpenCodePartRow = {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

export type OpenCodeProviderMetadata = {
  baseUrl: string | null;
  host: string | null;
};

export type OpenCodeProviderRegistry = Record<string, OpenCodeProviderMetadata>;

export type OpenCodeEventContext = {
  eventNamespace?: string | null;
  sourceAdapter?: SourceAdapter;
};

type OpenCodeTokenPayload = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

export function normalizeOpenCodeSessionRow(
  row: OpenCodeSessionRow,
  eventContext?: OpenCodeEventContext
): AnyEvent[] {
  const normalizedEventContext = resolveEventContext(eventContext);
  const events: AnyEvent[] = [
    {
      event_id: buildEventId(normalizedEventContext, `session:${row.id}:started`),
      session_id: row.id,
      timestamp: toIsoTimestamp(row.time_created),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: normalizedEventContext.sourceAdapter,
      workspace_path: normalizeWorkspacePath(row.directory),
      type: "session.started"
    }
  ];

  if (typeof row.time_archived === "number" && row.time_archived >= row.time_created) {
    events.push({
      event_id: buildEventId(normalizedEventContext, `session:${row.id}:ended`),
      session_id: row.id,
      timestamp: toIsoTimestamp(row.time_archived),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: normalizedEventContext.sourceAdapter,
      workspace_path: normalizeWorkspacePath(row.directory),
      type: "session.ended",
      duration_ms: Math.max(0, row.time_archived - row.time_created)
    });
  }

  return events;
}

export function normalizeOpenCodeMessageRow(input: {
  row: OpenCodeMessageRow;
  sessionDirectory?: string | null;
  sessionModel?: string | null;
  partRows?: OpenCodePartRow[];
  providerRegistry?: OpenCodeProviderRegistry;
  eventContext?: OpenCodeEventContext;
}): AnyEvent[] {
  const parsed = parseJsonRecord(input.row.data);
  if (parsed === null) {
    return [];
  }

  const role = normalizeOptionalString(parsed.role);
  if (role !== "user" && role !== "assistant") {
    return [];
  }

  const workspacePath = resolveWorkspacePath(parsed, input.sessionDirectory);
  const createdAt = resolveNestedTimestamp(parsed, "time", "created") ?? input.row.time_created;
  const completedAt = resolveNestedTimestamp(parsed, "time", "completed") ?? input.row.time_updated;
  const partRows = input.partRows ?? [];
  const eventContext = resolveEventContext(input.eventContext);

  if (role === "user") {
    return [
      {
        event_id: buildEventId(eventContext, `message:${input.row.id}:prompt`),
        session_id: input.row.session_id,
        timestamp: toIsoTimestamp(createdAt),
        source_vendor: OPENCODE_SOURCE_VENDOR,
        source_adapter: eventContext.sourceAdapter,
        workspace_path: workspacePath,
        type: "prompt.submitted",
        prompt_id: input.row.id,
        prompt_chars: sumTextPartChars(partRows)
      }
    ];
  }

  const providerId =
    normalizeOptionalString(parsed.providerID) ??
    normalizeOptionalString(readNestedValue(parsed, "model", "providerID")) ??
    null;
  const providerMetadata = providerId !== null ? input.providerRegistry?.[providerId] : undefined;
  const model =
    normalizeOptionalString(parsed.modelID) ??
    normalizeOptionalString(readNestedValue(parsed, "model", "modelID")) ??
    normalizeOptionalString(input.sessionModel) ??
    null;
  const stopReason =
    normalizeOptionalString(parsed.finish) ??
    normalizeOptionalString(readNestedValue(parsed, "error", "name")) ??
    normalizeOptionalString(readNestedValue(parsed, "error", "data", "message")) ??
    null;
  const responseChars = sumTextPartChars(partRows);
  const usagePart = findStepFinishUsagePart(partRows);
  const events: AnyEvent[] = [
    {
      event_id: buildEventId(eventContext, `message:${input.row.id}:assistant`),
      session_id: input.row.session_id,
      timestamp: toIsoTimestamp(completedAt),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: eventContext.sourceAdapter,
      workspace_path: workspacePath,
      type: "assistant.responded",
      message_id: input.row.id,
      model,
      stop_reason: stopReason,
      response_chars: responseChars,
      provider_id: providerId,
      provider_base_url: providerMetadata?.baseUrl ?? null,
      provider_host: providerMetadata?.host ?? null
    }
  ];
  const tokenPayload = extractTokenPayload(parsed);

  if (tokenPayload !== null && usagePart === null) {
    events.push({
      event_id: buildEventId(eventContext, `message:${input.row.id}:usage`),
      session_id: input.row.session_id,
      timestamp: toIsoTimestamp(completedAt),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: eventContext.sourceAdapter,
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
    });
  }

  return events;
}

export function normalizeOpenCodePartRow(input: {
  row: OpenCodePartRow;
  sessionDirectory?: string | null;
  sessionModel?: string | null;
  messageRow?: OpenCodeMessageRow | null;
  providerRegistry?: OpenCodeProviderRegistry;
  eventContext?: OpenCodeEventContext;
}): AnyEvent[] {
  const parsed = parseJsonRecord(input.row.data);
  if (parsed === null) {
    return [];
  }

  const partType = normalizeOptionalString(parsed.type);
  if (partType === "step-finish") {
    return normalizeOpenCodeStepFinishPart({
      row: input.row,
      part: parsed,
      sessionDirectory: input.sessionDirectory,
      sessionModel: input.sessionModel,
      messageRow: input.messageRow,
      providerRegistry: input.providerRegistry,
      eventContext: input.eventContext
    });
  }

  if (partType !== "tool") {
    return [];
  }

  const toolName = normalizeOptionalString(parsed.tool) ?? "unknown";
  const state = asRecord(parsed.state);
  const time = asRecord(state?.time);
  const status = normalizeOptionalString(state?.status);
  const startAt = normalizeInteger(time?.start) ?? input.row.time_created;
  const endAt =
    normalizeInteger(time?.end) ??
    (status === "completed" || status === "error" ? input.row.time_updated : null);
  const workspacePath = normalizeWorkspacePath(input.sessionDirectory);
  const eventContext = resolveEventContext(input.eventContext);
  const events: AnyEvent[] = [
    {
      event_id: buildEventId(eventContext, `part:${input.row.id}:tool:started`),
      session_id: input.row.session_id,
      timestamp: toIsoTimestamp(startAt),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: eventContext.sourceAdapter,
      workspace_path: workspacePath,
      type: "tool.called",
      tool_name: toolName,
      status: "started",
      argument_summary: serializeCompactJson(state?.input)
    }
  ];

  if ((status === "completed" || status === "error") && typeof endAt === "number") {
    const durationMs = Math.max(0, endAt - startAt);

    events.push(
      status === "completed"
        ? {
            event_id: buildEventId(eventContext, `part:${input.row.id}:tool:succeeded`),
            session_id: input.row.session_id,
            timestamp: toIsoTimestamp(endAt),
            source_vendor: OPENCODE_SOURCE_VENDOR,
            source_adapter: eventContext.sourceAdapter,
            workspace_path: workspacePath,
            type: "tool.succeeded",
            tool_name: toolName,
            status: "succeeded",
            duration_ms: durationMs
          }
        : {
            event_id: buildEventId(eventContext, `part:${input.row.id}:tool:failed`),
            session_id: input.row.session_id,
            timestamp: toIsoTimestamp(endAt),
            source_vendor: OPENCODE_SOURCE_VENDOR,
            source_adapter: eventContext.sourceAdapter,
            workspace_path: workspacePath,
            type: "tool.failed",
            tool_name: toolName,
            status: "failed",
            duration_ms: durationMs
          }
    );
  }

  return events;
}

export function normalizeOpenCodeToolPartRow(input: {
  row: OpenCodePartRow;
  sessionDirectory?: string | null;
  eventContext?: OpenCodeEventContext;
}): AnyEvent[] {
  return normalizeOpenCodePartRow(input);
}

function extractTokenPayload(message: Record<string, unknown>): OpenCodeTokenPayload | null {
  const tokens = asRecord(message.tokens);
  if (tokens === null) {
    return null;
  }

  const cache = asRecord(tokens.cache);
  const inputTokens = normalizeInteger(tokens.input) ?? 0;
  const outputTokens = (normalizeInteger(tokens.output) ?? 0) + (normalizeInteger(tokens.reasoning) ?? 0);
  const cacheCreationTokens = normalizeInteger(cache?.write) ?? 0;
  const cacheReadTokens = normalizeInteger(cache?.read) ?? 0;

  if (inputTokens === 0 && outputTokens === 0 && cacheCreationTokens === 0 && cacheReadTokens === 0) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens
  };
}

function normalizeOpenCodeStepFinishPart(input: {
  row: OpenCodePartRow;
  part: Record<string, unknown>;
  sessionDirectory?: string | null;
  sessionModel?: string | null;
  messageRow?: OpenCodeMessageRow | null;
  providerRegistry?: OpenCodeProviderRegistry;
  eventContext?: OpenCodeEventContext;
}): AnyEvent[] {
  const tokenPayload = extractTokenPayload(input.part);
  if (tokenPayload === null) {
    return [];
  }

  const messageRecord =
    input.messageRow !== null && input.messageRow !== undefined
      ? parseJsonRecord(input.messageRow.data)
      : null;
  const providerId =
    (messageRecord !== null
      ? normalizeOptionalString(messageRecord.providerID) ??
        normalizeOptionalString(readNestedValue(messageRecord, "model", "providerID"))
      : undefined) ?? null;
  const providerMetadata = providerId !== null ? input.providerRegistry?.[providerId] : undefined;
  const model =
    (messageRecord !== null
      ? normalizeOptionalString(messageRecord.modelID) ??
        normalizeOptionalString(readNestedValue(messageRecord, "model", "modelID"))
      : undefined) ??
    normalizeOptionalString(input.sessionModel) ??
    null;
  const workspacePath =
    messageRecord !== null
      ? resolveWorkspacePath(messageRecord, input.sessionDirectory)
      : normalizeWorkspacePath(input.sessionDirectory);
  const eventContext = resolveEventContext(input.eventContext);

  return [
    {
      event_id: buildEventId(eventContext, `message:${input.row.message_id}:usage`),
      session_id: input.row.session_id,
      timestamp: toIsoTimestamp(input.row.time_updated),
      source_vendor: OPENCODE_SOURCE_VENDOR,
      source_adapter: eventContext.sourceAdapter,
      workspace_path: workspacePath,
      type: "token.usage.recorded",
      message_id: input.row.message_id,
      model,
      input_tokens: tokenPayload.inputTokens,
      output_tokens: tokenPayload.outputTokens,
      cache_creation_input_tokens: tokenPayload.cacheCreationTokens,
      cache_read_input_tokens: tokenPayload.cacheReadTokens,
      server_tool_use: "{}",
      usage_source: "opencode-step-finish",
      provider_id: providerId,
      provider_base_url: providerMetadata?.baseUrl ?? null,
      provider_host: providerMetadata?.host ?? null
    }
  ];
}

function sumTextPartChars(partRows: OpenCodePartRow[]): number {
  let total = 0;

  for (const row of partRows) {
    const parsed = parseJsonRecord(row.data);
    if (parsed === null || normalizeOptionalString(parsed.type) !== "text") {
      continue;
    }

    total += (normalizeOptionalString(parsed.text) ?? "").length;
  }

  return total;
}

function findStepFinishUsagePart(partRows: OpenCodePartRow[]): OpenCodePartRow | null {
  for (const row of partRows) {
    const parsed = parseJsonRecord(row.data);
    if (parsed === null || normalizeOptionalString(parsed.type) !== "step-finish") {
      continue;
    }

    if (extractTokenPayload(parsed) !== null) {
      return row;
    }
  }

  return null;
}

function resolveWorkspacePath(message: Record<string, unknown>, sessionDirectory?: string | null): string {
  const pathRecord = asRecord(message.path);
  return normalizeWorkspacePath(
    normalizeOptionalString(pathRecord?.root) ??
      normalizeOptionalString(pathRecord?.cwd) ??
      sessionDirectory
  );
}

function readNestedValue(value: Record<string, unknown>, ...segments: string[]): unknown {
  let current: unknown = value;

  for (const segment of segments) {
    const record = asRecord(current);
    if (record === null) {
      return undefined;
    }

    current = record[segment];
  }

  return current;
}

function resolveNestedTimestamp(value: Record<string, unknown>, ...segments: string[]): number | null {
  const nested = readNestedValue(value, ...segments);
  return normalizeInteger(nested);
}

function normalizeWorkspacePath(value: string | null | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : ".";
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function serializeCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function toIsoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function resolveEventContext(eventContext?: OpenCodeEventContext): Required<OpenCodeEventContext> {
  return {
    eventNamespace: eventContext?.eventNamespace ?? null,
    sourceAdapter: eventContext?.sourceAdapter ?? OPENCODE_SOURCE_ADAPTER
  };
}

function buildEventId(eventContext: Required<OpenCodeEventContext>, suffix: string): string {
  return eventContext.eventNamespace
    ? `opencode:${eventContext.eventNamespace}:${suffix}`
    : `opencode:${suffix}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
