import { basename } from "node:path";
import type { AnyEvent, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

const CODEX_SOURCE_VENDOR: SourceVendor = "codex";
const CODEX_ROLLOUT_ADAPTER: SourceAdapter = "codex-rollout";

export type CodexProviderConfig = {
  baseUrl: string | null;
  host: string | null;
};

export function extractCodexEventsFromRollout(input: {
  filePath: string;
  contents: string;
  sessionModels?: Record<string, string>;
  providerConfigs?: Record<string, CodexProviderConfig>;
}): AnyEvent[] {
  const lines = input.contents.split(/\r?\n/u).filter((line) => line.length > 0);
  const events: AnyEvent[] = [];
  let sessionMeta:
    | {
        sessionId: string;
        timestamp: string;
        workspacePath: string;
        providerId: string | null;
      }
    | null = null;

  for (const line of lines) {
    const parsed = parseJsonRecord(line);
    if (parsed === null) {
      continue;
    }

    const eventType = normalizeOptionalString(parsed.type);
    const payload = asRecord(parsed.payload);

    if (eventType === "session_meta" && payload !== null) {
      const sessionId =
        normalizeOptionalString(payload.id) ?? inferSessionIdFromPath(input.filePath);
      const timestamp =
        normalizeOptionalString(payload.timestamp) ??
        normalizeOptionalString(parsed.timestamp);

      if (sessionId === null || timestamp === null) {
        continue;
      }

      sessionMeta = {
        sessionId,
        timestamp,
        workspacePath: normalizeOptionalString(payload.cwd) ?? ".",
        providerId: normalizeOptionalString(payload.model_provider)
      };
      events.push({
        event_id: `codex:session:${sessionId}:started`,
        session_id: sessionId,
        timestamp,
        source_vendor: CODEX_SOURCE_VENDOR,
        source_adapter: CODEX_ROLLOUT_ADAPTER,
        workspace_path: sessionMeta.workspacePath,
        type: "session.started"
      });
      continue;
    }

    if (
      eventType !== "event_msg" ||
      payload === null ||
      normalizeOptionalString(payload.type) !== "token_count"
    ) {
      continue;
    }

    const info = asRecord(payload.info);
    if (info === null) {
      continue;
    }

    const totalUsage = asRecord(info.total_token_usage);
    const lastUsage = asRecord(info.last_token_usage);
    if (lastUsage === null && totalUsage === null) {
      continue;
    }

    const sessionId = sessionMeta?.sessionId ?? inferSessionIdFromPath(input.filePath);
    if (sessionId === null) {
      continue;
    }

    const totalTokens =
      normalizeInteger(totalUsage?.total_tokens) ??
      normalizeInteger(lastUsage?.total_tokens);
    if (totalTokens === null) {
      continue;
    }

    const inputTokens = normalizeInteger(lastUsage?.input_tokens) ?? 0;
    const cacheReadTokens = normalizeInteger(lastUsage?.cached_input_tokens) ?? 0;
    const outputTokens =
      (normalizeInteger(lastUsage?.output_tokens) ?? 0) +
      (normalizeInteger(lastUsage?.reasoning_output_tokens) ?? 0);

    if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) {
      continue;
    }

    const providerId = sessionMeta?.providerId ?? null;
    const providerConfig = providerId ? input.providerConfigs?.[providerId] : undefined;

    events.push({
      event_id: `codex:session:${sessionId}:usage:${totalTokens}`,
      session_id: sessionId,
      timestamp:
        normalizeOptionalString(parsed.timestamp) ??
        sessionMeta?.timestamp ??
        new Date(0).toISOString(),
      source_vendor: CODEX_SOURCE_VENDOR,
      source_adapter: CODEX_ROLLOUT_ADAPTER,
      workspace_path: sessionMeta?.workspacePath ?? ".",
      type: "token.usage.recorded",
      message_id: `usage_${totalTokens}`,
      model: input.sessionModels?.[sessionId] ?? null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheReadTokens,
      server_tool_use: "{}",
      usage_source: "codex-rollout",
      provider_id: providerId,
      provider_base_url: providerConfig?.baseUrl ?? null,
      provider_host: providerConfig?.host ?? null
    });
  }

  return events.sort((left, right) =>
    left.timestamp === right.timestamp
      ? left.event_id.localeCompare(right.event_id)
      : left.timestamp.localeCompare(right.timestamp)
  );
}

export function inferSessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath);
  const match = /^rollout-.*-([0-9a-f]{8,}-[0-9a-f-]+)\.jsonl$/iu.exec(name);
  return match?.[1] ?? null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
