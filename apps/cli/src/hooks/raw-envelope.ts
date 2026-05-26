import type { ClaudeRawEnvelope } from "@agent-metrics/adapters-claude";

export function parseClaudeRawEnvelope(value: unknown): ClaudeRawEnvelope | null {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
