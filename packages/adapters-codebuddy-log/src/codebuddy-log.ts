import { normalizeWorkspacePath, toNormalizedEventV2 } from "@agent-metrics/event-schema";
import type { AnyEvent, NormalizedEventV2, SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

/**
 * CodeBuddy CLI keeps a per-process request log under
 * `~/.codebuddy/logs/<YYYY-MM-DD>/<workspace-slug>__<hash>.log`. Unlike the
 * JSONL transcripts it writes for interactive sessions, this log is emitted in
 * every mode, including the headless `--print` runs that `--no-session-persistence`
 * keeps out of `projects/`, so it is the only place those calls are recorded.
 *
 * Two line shapes matter:
 *   `qua.end: {"conversation_id":..., "message_id":..., "prompt_tokens":...}`
 *   `Credit received: rootRequestId=..., source=..., credit=0.05`
 *
 * `conversation_id` is the CLI session id (identical to the transcript's
 * `sessionId`), `conversation_request_id` is the id of one user turn, and every
 * model call inside that turn repeats it — so credit can only be attributed by
 * order, not by id: each `Credit received` line immediately follows the
 * `qua.end` of the request it bills.
 */
const CODEBUDDY_LOG_SOURCE_VENDOR: SourceVendor = "workbuddy";
const CODEBUDDY_LOG_SOURCE_ADAPTER: SourceAdapter = "codebuddy-cli-log";

const QUA_END_PATTERN = /qua\.end: (\{.*\})\s*$/u;
/**
 * The transport log reports prompt/completion tokens but not how much of the
 * prompt was served from cache. The provider layer logs that separately, on the
 * line right after the `qua.end` of the same call:
 *   [ModelProvider] {"model":...,"input_tokens":24217,"cached_read_tokens":1408,...}
 * `input_tokens` there equals the `prompt_tokens` of that call, so the two lines
 * can be paired by session plus token count.
 */
const MODEL_CALL_MARKER = "agent.model_call.completed";
const MODEL_CALL_JSON_START = '{"model"';
const CREDIT_PATTERN = /Credit received: rootRequestId=([^,\s]+), source=([^,\s]+), credit=(\S+)/u;
/** Only the streaming event reports an amount; `response_done` repeats the id with none. */
const CREDIT_SOURCE = "raw_model_stream_event";
const LOG_TIMESTAMP_PATTERN =
  /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/u;
const MAIN_SESSION_PATTERN = /Registered mainSession: id=([^,\s]+), meta=(\{.*\})\s*$/u;
const WORKSPACE_PATTERN = /[Ww]orkspace [Pp]ath: (\S.*?)\s*$/u;

export type CodebuddyLogRequest = {
  /** CLI session id; equals the transcript `sessionId` for the same session. */
  sessionId: string;
  messageId: string;
  requestId: string;
  workspacePath: string;
  timestamp: number;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  firstTokenLatencyMs: number | null;
  decodeDurationMs: number | null;
  /** Cached prompt tokens reported by the provider layer; 0 when it logged none. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Credit units billed for this request; null when the log reported none. */
  credit: number | null;
};

export type CodebuddyLogScan = {
  requests: CodebuddyLogRequest[];
  /** First timestamp seen per session, used for the session header. */
  sessionStartedAt: Map<string, number>;
};

/**
 * Parse one request-log file into per-request usage records.
 *
 * The whole file is re-read on every change (the caller decides when), because
 * the credit line for a request may be flushed after the `qua.end` line it
 * belongs to and the paired credit must be attached to that same record.
 */
export function parseCodebuddyLog(text: string, fallbackWorkspace: string): CodebuddyLogScan {
  const requests = new Map<string, CodebuddyLogRequest>();
  const sessionStartedAt = new Map<string, number>();
  const sessionWorkspaces = new Map<string, string>();
  let fileWorkspace: string | null = null;
  // Billing and usage are written by different code paths, so a `Credit
  // received` line can precede or follow the `qua.end` of its request. Both
  // directions are buffered per turn and reconciled as soon as the other side
  // shows up.
  const creditByRequest = new Map<string, number[]>();
  const requestsAwaitingCredit = new Map<string, string[]>();
  // Provider-layer cache accounting arrives on its own line, so calls wait here
  // until their cache figures show up.
  const requestsAwaitingCache = new Map<string, string[]>();

  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0 || !isInterestingLine(line)) {
      continue;
    }

    const mainSession = MAIN_SESSION_PATTERN.exec(line);
    if (mainSession !== null) {
      const sessionId = mainSession[1]!;
      const cwd = readWorkspaceFromMeta(mainSession[2]!);
      if (cwd !== null) {
        const normalized = normalizeWorkspacePath(cwd);
        sessionWorkspaces.set(sessionId, normalized);
        fileWorkspace ??= normalized;
      }
      continue;
    }

    const workspaceMatch = WORKSPACE_PATTERN.exec(line);
    if (workspaceMatch !== null) {
      fileWorkspace ??= normalizeWorkspacePath(workspaceMatch[1]!);
      continue;
    }

    const creditMatch = CREDIT_PATTERN.exec(line);
    if (creditMatch !== null) {
      const [, requestId, source, rawCredit] = creditMatch;
      // `response_done` repeats the request id with no amount and is not a
      // billable line; only the streaming event reports a credit.
      const credit = source === CREDIT_SOURCE ? readNonNegativeNumber(rawCredit) : null;
      if (credit === null) {
        continue;
      }
      const awaiting = requestsAwaitingCredit.get(requestId!);
      const messageId = awaiting?.shift();
      if (messageId !== undefined) {
        const request = requests.get(messageId);
        if (request !== undefined) {
          request.credit = credit;
        }
        continue;
      }
      const queued = creditByRequest.get(requestId!);
      if (queued === undefined) {
        creditByRequest.set(requestId!, [credit]);
      } else {
        queued.push(credit);
      }
      continue;
    }

    if (line.includes(MODEL_CALL_MARKER)) {
      const payload = readModelCallPayload(line);
      if (payload !== null) {
        applyCacheAccounting(payload, requests, requestsAwaitingCache);
      }
      continue;
    }

    const quaEndMatch = QUA_END_PATTERN.exec(line);
    if (quaEndMatch === null) {
      continue;
    }

    const payload = parseJsonRecord(quaEndMatch[1]!);
    if (payload === null) {
      continue;
    }

    const messageId = readString(payload.message_id);
    const sessionId = readString(payload.conversation_id);
    const requestId = readString(payload.conversation_request_id);
    if (messageId === null || sessionId === null) {
      continue;
    }

    const timestamp = readLogTimestamp(line);
    if (timestamp === null) {
      continue;
    }

    const promptTokens = readNonNegativeInt(payload.prompt_tokens) ?? 0;
    const completionTokens = readNonNegativeInt(payload.completion_tokens) ?? 0;
    // A failed or empty call still bills nothing; keeping it would create
    // zero-token rows that the canonical projector rejects anyway.
    if (promptTokens === 0 && completionTokens === 0) {
      continue;
    }

    const ttft = readNonNegativeInt(payload.ttft_ms);
    const totalCost = readNonNegativeInt(payload.total_cost_ms);
    const decodeDurationMs =
      ttft !== null && totalCost !== null && totalCost > ttft ? totalCost - ttft : null;

    const previous = requests.get(messageId);
    requests.set(messageId, {
      sessionId,
      messageId,
      requestId: requestId ?? messageId,
      workspacePath:
        sessionWorkspaces.get(sessionId) ?? fileWorkspace ?? fallbackWorkspace,
      // A retried request re-reports the same message; the last record carries
      // the final accounting, but the earliest sighting anchors the session.
      timestamp: previous?.timestamp ?? timestamp,
      model: readString(payload.model) ?? previous?.model ?? null,
      promptTokens,
      completionTokens,
      firstTokenLatencyMs: ttft,
      decodeDurationMs,
      cacheReadTokens: previous?.cacheReadTokens ?? 0,
      cacheCreationTokens: previous?.cacheCreationTokens ?? 0,
      credit: previous?.credit ?? null
    });

    if (!sessionStartedAt.has(sessionId)) {
      sessionStartedAt.set(sessionId, timestamp);
    }
    // Cache figures are keyed by session rather than turn, so every request
    // queues here — including the single-shot calls that carry no request id.
    const awaitingCache = requestsAwaitingCache.get(sessionId);
    if (awaitingCache === undefined) {
      requestsAwaitingCache.set(sessionId, [messageId]);
    } else if (!awaitingCache.includes(messageId)) {
      awaitingCache.push(messageId);
    }
    if (requestId === null) {
      continue;
    }
    // A billing line that arrived first is claimed here; otherwise this request
    // waits for its credit to show up later in the file.
    const queuedCredit = creditByRequest.get(requestId);
    const credit = queuedCredit?.shift();
    if (credit !== undefined) {
      const request = requests.get(messageId);
      if (request !== undefined) {
        request.credit = credit;
      }
      continue;
    }
    const awaiting = requestsAwaitingCredit.get(requestId);
    if (awaiting === undefined) {
      requestsAwaitingCredit.set(requestId, [messageId]);
    } else {
      awaiting.push(messageId);
    }
  }

  return {
    requests: [...requests.values()].sort((left, right) => left.timestamp - right.timestamp),
    sessionStartedAt
  };
}

export function normalizeCodebuddyLogSessionHeader(header: {
  sessionId: string;
  startedAt: number;
  workspacePath: string;
}): NormalizedEventV2[] {
  return [
    toNormalizedEventV2({
      event_id: buildEventId(header.sessionId, `started`),
      session_id: header.sessionId,
      timestamp: new Date(header.startedAt).toISOString(),
      source_vendor: CODEBUDDY_LOG_SOURCE_VENDOR,
      source_adapter: CODEBUDDY_LOG_SOURCE_ADAPTER,
      workspace_path: normalizeWorkspacePath(header.workspacePath),
      type: "session.started"
    })
  ];
}

export function normalizeCodebuddyLogRequest(request: CodebuddyLogRequest): NormalizedEventV2 {
  const event: AnyEvent = {
    event_id: buildEventId(request.sessionId, `usage:${request.messageId}`),
    session_id: request.sessionId,
    timestamp: new Date(request.timestamp).toISOString(),
    source_vendor: CODEBUDDY_LOG_SOURCE_VENDOR,
    source_adapter: CODEBUDDY_LOG_SOURCE_ADAPTER,
    workspace_path: normalizeWorkspacePath(request.workspacePath),
    type: "token.usage.recorded",
    message_id: request.messageId,
    model: request.model,
    input_tokens: request.promptTokens,
    output_tokens: request.completionTokens,
    cache_creation_input_tokens: request.cacheCreationTokens,
    cache_read_input_tokens: request.cacheReadTokens,
    server_tool_use: "{}",
    usage_source: "codebuddy-log",
    ...(request.credit === null ? {} : { credit: request.credit }),
    first_token_latency_ms: request.firstTokenLatencyMs,
    decode_duration_ms: request.decodeDurationMs,
    provider_id: "unknown",
    provider_base_url: null,
    provider_host: null
  };
  return toNormalizedEventV2(event, { sourceRecordId: `codebuddy-cli:usage:${request.messageId}` });
}

function buildEventId(sessionId: string, suffix: string): string {
  return `codebuddy-cli:${sessionId}:${suffix}`;
}

/**
 * A debug log is mostly unrelated chatter (streaming chunks, git probes), and a
 * single file can exceed 100k lines. A cheap substring gate keeps the regular
 * expressions off those lines.
 */
function isInterestingLine(line: string): boolean {
  return (
    line.includes("qua.end:") ||
    line.includes("Credit received:") ||
    line.includes(MODEL_CALL_MARKER) ||
    line.includes("Registered mainSession:") ||
    line.includes("orkspace Path:") ||
    line.includes("orkspace path:")
  );
}

function readWorkspaceFromMeta(meta: string): string | null {
  const parsed = parseJsonRecord(meta);
  return parsed === null ? null : readString(parsed.cwd);
}

function readModelCallPayload(line: string): Record<string, unknown> | null {
  const start = line.indexOf(MODEL_CALL_JSON_START);
  if (start === -1) {
    return null;
  }
  const end = line.lastIndexOf("}");
  if (end <= start) {
    return null;
  }
  return parseJsonRecord(line.slice(start, end + 1));
}

/**
 * Attach provider-layer cache figures to the request they bill. The line carries
 * no message id, so the request is located by session and then confirmed on the
 * prompt size both lines report for the same call.
 */
function applyCacheAccounting(
  payload: Record<string, unknown>,
  requests: Map<string, CodebuddyLogRequest>,
  awaiting: Map<string, string[]>
): void {
  const sessionId = readString(payload.conversation_id);
  const inputTokens = readNonNegativeInt(payload.input_tokens);
  if (sessionId === null || inputTokens === null) {
    return;
  }
  const queue = awaiting.get(sessionId);
  if (queue === undefined || queue.length === 0) {
    return;
  }
  let index = queue.findIndex((id) => requests.get(id)?.promptTokens === inputTokens);
  if (index === -1) {
    index = 0;
  }
  const [messageId] = queue.splice(index, 1);
  if (messageId === undefined) {
    return;
  }
  const request = requests.get(messageId);
  if (request === undefined) {
    return;
  }
  // Gross input must stay >= cache-read; clamp so a mismatched pairing cannot
  // produce an event the schema rejects.
  const limit = request.promptTokens;
  request.cacheReadTokens = Math.min(readNonNegativeInt(payload.cached_read_tokens) ?? 0, limit);
  request.cacheCreationTokens = Math.min(
    readNonNegativeInt(payload.cached_write_tokens) ?? 0,
    limit
  );
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readLogTimestamp(line: string): number | null {
  const match = LOG_TIMESTAMP_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const [, year, month, day, hour, minute, second, millis] = match;
  const ms = millis === undefined ? 0 : Number(millis.padEnd(3, "0"));
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    ms
  ).getTime();
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    return Number(value);
  }
  return null;
}

function readNonNegativeNumber(value: string | undefined): number | null {
  if (value === undefined || value === "undefined") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
