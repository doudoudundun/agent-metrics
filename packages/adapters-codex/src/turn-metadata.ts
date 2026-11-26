import { normalizeModelId } from "@agent-metrics/event-schema";

export type CodexTurnInputMetadata = {
  model: string;
  serviceTier: string;
};

export type CodexTurnInputLogRow = {
  target: string | null;
  thread_id: string | null;
  feedback_log_body: string | null;
};

type ParsedTurnInput = CodexTurnInputMetadata & {
  sessionId: string;
  turnId: string;
};

export function codexTurnMetadataKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`;
}

/**
 * Accept only structured turn-input records. The service tier lives inside
 * tags_json; it must never be recovered by searching arbitrary log text.
 */
export function collectCodexTurnInputMetadata(
  rows: readonly CodexTurnInputLogRow[]
): ReadonlyMap<string, CodexTurnInputMetadata> {
  const grouped = new Map<
    string,
    { sessionId: string; turnId: string; models: Set<string>; tiers: Set<string> }
  >();

  for (const row of rows) {
    const parsed = parseCodexTurnInputRow(row);
    if (parsed === null) {
      continue;
    }

    const key = codexTurnMetadataKey(parsed.sessionId, parsed.turnId);
    const group = grouped.get(key) ?? {
      sessionId: parsed.sessionId,
      turnId: parsed.turnId,
      models: new Set<string>(),
      tiers: new Set<string>()
    };
    group.models.add(parsed.model);
    group.tiers.add(parsed.serviceTier);
    grouped.set(key, group);
  }

  const result = new Map<string, CodexTurnInputMetadata>();
  for (const [key, group] of grouped) {
    if (group.models.size !== 1 || group.tiers.size !== 1) {
      continue;
    }

    result.set(key, {
      model: [...group.models][0],
      serviceTier: [...group.tiers][0]
    });
  }
  return result;
}

function parseCodexTurnInputRow(row: CodexTurnInputLogRow): ParsedTurnInput | null {
  if (row.target !== "feedback_tags" || !row.thread_id || !row.feedback_log_body) {
    return null;
  }

  const body = row.feedback_log_body;
  const sessionLoop = readEnvelope(body, "session_loop{", 0);
  if (sessionLoop === null || sessionLoop.start !== 0) {
    return null;
  }

  const sessionFields = parseLogfmtFields(sessionLoop.contents);
  const dispatch = readEnvelope(body, ":submission_dispatch{", sessionLoop.end);
  if (
    sessionFields === null ||
    dispatch === null ||
    dispatch.start !== sessionLoop.end ||
    findOutsideQuotes(body, ":submission_dispatch{", dispatch.end) !== null
  ) {
    return null;
  }

  const dispatchFields = parseLogfmtFields(dispatch.contents);
  if (dispatchFields === null) {
    return null;
  }

  const dispatchName = uniqueField(dispatchFields, "otel.name");
  if (dispatchName === "op.dispatch.turn_input") {
    return parseTurnInputSpan(row, body, sessionFields, dispatch, dispatchFields);
  }
  if (dispatchName === "op.dispatch.inter_agent_communication") {
    return parseInterAgentSamplingSpan(row, body, sessionFields, dispatch, dispatchFields);
  }
  return null;
}

function parseTurnInputSpan(
  row: CodexTurnInputLogRow,
  body: string,
  sessionFields: ParsedLogfmtFields,
  dispatch: ParsedEnvelope,
  dispatchFields: ParsedLogfmtFields
): ParsedTurnInput | null {
  const codexTurn = readEnvelope(body, ":codex.turn_input{", dispatch.end);
  const turn = codexTurn && readEnvelope(body, ":turn{", codexTurn.end);
  if (
    codexTurn === null ||
    turn === null ||
    codexTurn.start !== dispatch.end ||
    turn.start !== codexTurn.end ||
    findOutsideQuotes(body, ":codex.turn_input{", codexTurn.end) !== null ||
    findOutsideQuotes(body, ":turn{", turn.end) !== null
  ) {
    return null;
  }

  const codexTurnFields = parseLogfmtFields(codexTurn.contents);
  const turnFields = parseLogfmtFields(turn.contents);
  if (
    codexTurnFields === null ||
    turnFields === null
  ) {
    return null;
  }

  const sessionId = uniqueAcrossFields([sessionFields, dispatchFields, codexTurnFields, turnFields], [
    "thread_id",
    "thread.id"
  ]);
  const turnThreadId = uniqueField(turnFields, "thread.id");
  const turnId = uniqueAcrossFields(
    [sessionFields, dispatchFields, codexTurnFields, turnFields],
    ["turn.id", "turn_id"]
  );
  const turnInputId = uniqueField(codexTurnFields, "turn.id");
  const modelValue = uniqueAcrossFields(
    [sessionFields, dispatchFields, codexTurnFields, turnFields],
    ["model"]
  );
  const turnSpanId = uniqueField(turnFields, "turn.id");
  const encodedTags = parseTagsJsonAfter(body.slice(turn.end));
  const model = normalizeModelId(modelValue);
  if (
    sessionId === null ||
    sessionId !== turnThreadId ||
    sessionId !== row.thread_id ||
    turnId === null ||
    turnId !== turnInputId ||
    turnId !== turnSpanId ||
    model === null ||
    uniqueField(turnFields, "model") === null ||
    encodedTags === null
  ) {
    return null;
  }

  const serviceTier = parseServiceTier(encodedTags);
  return serviceTier === null ? null : { sessionId, turnId, model, serviceTier };
}

/**
 * Newer Codex builds attach request sampling spans to inter-agent dispatches
 * instead of emitting codex.turn_input. Accept the local tier only when the
 * enclosing session, turn, model, and both sampling spans agree. This is
 * requested-tier metadata, not confirmation of the tier used by the server.
 */
function parseInterAgentSamplingSpan(
  row: CodexTurnInputLogRow,
  body: string,
  sessionFields: ParsedLogfmtFields,
  dispatch: ParsedEnvelope,
  dispatchFields: ParsedLogfmtFields
): ParsedTurnInput | null {
  const turn = readEnvelope(body, ":turn{", dispatch.end);
  const sampling = turn && readEnvelope(body, ":run_sampling_request{", turn.end);
  const trySampling = sampling && readEnvelope(body, ":try_run_sampling_request{", sampling.end);
  if (
    turn === null ||
    sampling === null ||
    trySampling === null ||
    turn.start !== dispatch.end ||
    body.slice(turn.end, sampling.start) !== ":session_task.run:run_turn" ||
    body.slice(sampling.end, trySampling.start) !== "" ||
    findOutsideQuotes(body, ":codex.turn_input{", dispatch.end) !== null ||
    findOutsideQuotes(body, ":turn{", turn.end) !== null ||
    findOutsideQuotes(body, ":run_sampling_request{", sampling.end) !== null ||
    findOutsideQuotes(body, ":try_run_sampling_request{", trySampling.end) !== null
  ) {
    return null;
  }

  const turnFields = parseLogfmtFields(turn.contents);
  const samplingFields = parseLogfmtFields(sampling.contents);
  const trySamplingFields = parseLogfmtFields(trySampling.contents);
  if (turnFields === null || samplingFields === null || trySamplingFields === null) {
    return null;
  }

  const fieldSets = [sessionFields, dispatchFields, turnFields, samplingFields, trySamplingFields];
  const sessionId = uniqueAcrossFields(fieldSets, ["thread_id", "thread.id"]);
  const turnThreadId = uniqueField(turnFields, "thread.id");
  const turnId = uniqueAcrossFields(fieldSets, ["turn.id", "turn_id"]);
  const turnSpanId = uniqueField(turnFields, "turn.id");
  const samplingTurnId = uniqueField(samplingFields, "turn_id");
  const trySamplingTurnId = uniqueField(trySamplingFields, "turn_id");
  const modelValue = uniqueAcrossFields(fieldSets, ["model"]);
  const turnModel = uniqueField(turnFields, "model");
  const samplingModel = uniqueField(samplingFields, "model");
  const trySamplingModel = uniqueField(trySamplingFields, "model");
  const encodedTags = parseTagsJsonAfter(body.slice(trySampling.end));
  const model = normalizeModelId(modelValue);

  if (
    uniqueField(turnFields, "otel.name") !== "session_task.turn" ||
    sessionId === null ||
    sessionId !== turnThreadId ||
    sessionId !== row.thread_id ||
    turnId === null ||
    turnId !== turnSpanId ||
    turnId !== samplingTurnId ||
    turnId !== trySamplingTurnId ||
    model === null ||
    turnModel === null ||
    samplingModel === null ||
    trySamplingModel === null ||
    normalizeModelId(turnModel) !== model ||
    normalizeModelId(samplingModel) !== model ||
    normalizeModelId(trySamplingModel) !== model ||
    encodedTags === null
  ) {
    return null;
  }

  const serviceTier = parseServiceTier(encodedTags);
  return serviceTier === null ? null : { sessionId, turnId, model, serviceTier };
}

function parseServiceTier(encodedTags: string): string | null {
  let tags: unknown;
  try {
    tags = JSON.parse(encodedTags) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(tags)) {
    return null;
  }

  const serviceTier = uniqueTopLevelStringProperty(encodedTags, "service_tier");
  if (serviceTier === null) {
    return null;
  }

  return serviceTier;
}

type ParsedLogfmtFields = Map<string, string[]>;

type ParsedEnvelope = {
  start: number;
  contentsStart: number;
  contents: string;
  end: number;
};

/** Read a named nested span while respecting quoted field values. */
function readEnvelope(value: string, marker: string, startAt: number): ParsedEnvelope | null {
  const start = findOutsideQuotes(value, marker, startAt);
  if (start === null) {
    return null;
  }

  const contentsStart = start + marker.length;
  let depth = 1;
  let quoted = false;
  let escaped = false;
  for (let index = contentsStart; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          start,
          contentsStart,
          contents: value.slice(contentsStart, index),
          end: index + 1
        };
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function findOutsideQuotes(value: string, marker: string, startAt: number): number | null {
  let quoted = false;
  let escaped = false;
  for (let index = startAt; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && value.startsWith(marker, index)) {
      return index;
    }
  }
  return null;
}

/** Parse logfmt fields in one known span. Duplicate keys are retained for validation. */
function parseLogfmtFields(value: string): ParsedLogfmtFields | null {
  const fields: ParsedLogfmtFields = new Map();
  let index = 0;

  while (index < value.length) {
    while (isWhitespace(value[index])) index += 1;
    if (index >= value.length) break;

    const keyStart = index;
    while (index < value.length && value[index] !== "=" && !isWhitespace(value[index])) {
      index += 1;
    }
    if (index === keyStart || value[index] !== "=") {
      return null;
    }

    const key = value.slice(keyStart, index);
    index += 1;
    if (index >= value.length || isWhitespace(value[index])) {
      return null;
    }

    let parsed: { value: string; nextIndex: number } | null;
    if (value[index] === '"') {
      parsed = parseQuotedValue(value, index);
    } else if (value[index] === "{") {
      parsed = parseJsonObjectValue(value, index);
    } else {
      let end = index;
      while (end < value.length && !isWhitespace(value[end])) end += 1;
      parsed = { value: value.slice(index, end), nextIndex: end };
    }

    if (parsed === null) {
      return null;
    }
    const existing = fields.get(key) ?? [];
    existing.push(parsed.value);
    fields.set(key, existing);
    index = parsed.nextIndex;
    if (index < value.length && !isWhitespace(value[index])) {
      return null;
    }
  }

  return fields;
}

function uniqueField(fields: ParsedLogfmtFields, key: string): string | null {
  const values = fields.get(key);
  if (values === undefined || values.length === 0) {
    return null;
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0) || new Set(normalized).size !== 1) {
    return null;
  }
  return normalized[0];
}

function uniqueAcrossFields(fields: readonly ParsedLogfmtFields[], keys: readonly string[]): string | null {
  const values = fields.flatMap((fieldSet) =>
    keys.flatMap((key) => fieldSet.get(key) ?? [])
  );
  if (values.length === 0) {
    return null;
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0) || new Set(normalized).size !== 1) {
    return null;
  }
  return normalized[0];
}

/** Find tags_json only in the post-turn tail of this structured log record. */
function parseTagsJsonAfter(value: string): string | null {
  let index = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  while (index < value.length) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (quoted) {
      index += 1;
      continue;
    }
    if (character === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
      index += 1;
      continue;
    }

    const hasFieldBoundary = index === 0 || isWhitespace(value[index - 1]) || value[index - 1] === "{";
    if (depth === 0 && hasFieldBoundary && value.startsWith("tags_json=", index)) {
      const parsed = parseJsonObjectValue(value, index + "tags_json=".length);
      if (parsed === null) {
        return null;
      }
      return value.slice(parsed.nextIndex).trim().length === 0 ? parsed.value : null;
    }
    index += 1;
  }

  return null;
}

function parseQuotedValue(value: string, start: number): { value: string; nextIndex: number } | null {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      try {
        return {
          value: JSON.parse(value.slice(start, index + 1)) as string,
          nextIndex: index + 1
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseJsonObjectValue(value: string, start: number): { value: string; nextIndex: number } | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const encoded = value.slice(start, index + 1);
        try {
          JSON.parse(encoded);
        } catch {
          return null;
        }
        return { value: encoded, nextIndex: index + 1 };
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

/** Read exactly one top-level JSON property, preserving duplicate-key evidence. */
function uniqueTopLevelStringProperty(value: string, property: string): string | null {
  let index = skipJsonWhitespace(value, 0);
  if (value[index] !== "{") {
    return null;
  }
  index += 1;
  const matches: unknown[] = [];

  while (index < value.length) {
    index = skipJsonWhitespace(value, index);
    if (value[index] === "}") {
      index = skipJsonWhitespace(value, index + 1);
      return index === value.length && matches.length === 1
        ? nonEmptyString(matches[0])
        : null;
    }

    const parsedKey = parseQuotedValue(value, index);
    if (parsedKey === null) {
      return null;
    }
    index = skipJsonWhitespace(value, parsedKey.nextIndex);
    if (value[index] !== ":") {
      return null;
    }
    index = skipJsonWhitespace(value, index + 1);
    const valueStart = index;
    const valueEnd = skipJsonValue(value, valueStart);
    if (valueEnd === null) {
      return null;
    }
    if (parsedKey.value === property) {
      try {
        matches.push(JSON.parse(value.slice(valueStart, valueEnd)) as unknown);
      } catch {
        return null;
      }
    }
    index = skipJsonWhitespace(value, valueEnd);
    if (value[index] === ",") {
      index += 1;
      continue;
    }
    if (value[index] !== "}") {
      return null;
    }
  }

  return null;
}

function skipJsonValue(value: string, start: number): number | null {
  if (value[start] === '"') {
    return parseQuotedValue(value, start)?.nextIndex ?? null;
  }
  if (value[start] === "{" || value[start] === "[") {
    const closing = new Map<string, string>([["{", "}"], ["[", "]"]]);
    const stack = [closing.get(value[start]) as string];
    let quoted = false;
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (quoted) {
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(closing.get(character) as string);
      } else if (character === "}" || character === "]") {
        if (stack.pop() !== character) {
          return null;
        }
        if (stack.length === 0) {
          return index + 1;
        }
      }
    }
    return null;
  }

  let index = start;
  while (
    index < value.length &&
    !isWhitespace(value[index]) &&
    value[index] !== "," &&
    value[index] !== "}" &&
    value[index] !== "]"
  ) {
    index += 1;
  }
  return index > start ? index : null;
}

function skipJsonWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && isWhitespace(value[index])) {
    index += 1;
  }
  return index;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
