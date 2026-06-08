import { createHash } from "node:crypto";
import type { ClaudeRawEnvelope } from "@agent-metrics/adapters-claude";

export function parseClaudeRawEnvelope(value: unknown): ClaudeRawEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!isRecord(value.payload)) {
    return parseLegacyClaudeRawPayload(value);
  }

  if (
    typeof value.raw_event_id !== "string" ||
    value.raw_event_id.length === 0 ||
    typeof value.captured_at !== "string" ||
    value.captured_at.length === 0 ||
    typeof value.hook_event_name !== "string" ||
    value.hook_event_name.length === 0
  ) {
    return null;
  }

  return value as ClaudeRawEnvelope;
}

function parseLegacyClaudeRawPayload(value: Record<string, unknown>): ClaudeRawEnvelope | null {
  if (typeof value.hook_event_name !== "string" || value.hook_event_name.length === 0) {
    return null;
  }

  const capturedAt =
    typeof value.timestamp === "string" && value.timestamp.length > 0
      ? value.timestamp
      : new Date().toISOString();

  return {
    raw_event_id: `legacy:${hashRawPayload(value)}`,
    captured_at: capturedAt,
    hook_event_name: value.hook_event_name,
    payload: value
  } as ClaudeRawEnvelope;
}

function hashRawPayload(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
