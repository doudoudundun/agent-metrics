import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import Database from "better-sqlite3";

const MAX_VARINT_BYTES = 10;
const MAX_REASONABLE_DURATION_SECONDS = 86_400n;
const NANOS_PER_SECOND = 1_000_000_000n;
const MAX_SAFE_INT_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type AntigravityTimingSample = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  firstTokenLatencyMs: number | null;
  decodeDurationMs: number | null;
};

/**
 * Per-step timing telemetry keyed by `step_index`. A `null` value records an
 * ambiguous `step_index` (conflicting `gen_metadata` rows) so matching rejects
 * it rather than attributing the wrong timing.
 */
export type AntigravityTimingIndex = ReadonlyMap<number, AntigravityTimingSample | null>;

type ProtobufField =
  | { fieldNumber: number; wireType: 0; value: bigint }
  | { fieldNumber: number; wireType: 2; value: Uint8Array }
  | { fieldNumber: number; wireType: 1 | 5 };

/**
 * Decode one serialized `GeneratorMetadata` protobuf blob from Antigravity's
 * `conversations/<session>.db` `gen_metadata` table.
 *
 * Only `step_indices` (field 2) and nested `ChatMessageMetadata` (field 1)
 * usage/timing counters (`ModelUsage` field 4, `time_to_first_token` field 11,
 * `streaming_duration` field 12) are inspected; model names stay strictly on
 * `transcript_full.jsonl` because `gen_metadata` records base routing names.
 */
export function decodeAntigravityGenMetadataRow(
  data: Uint8Array
): { stepIndex: number; sample: AntigravityTimingSample } | null {
  const topFields = parseProtobufFields(data);
  if (topFields === null) {
    return null;
  }

  const stepIndices: number[] = [];
  let chatMessageBytes: Uint8Array | null = null;

  for (const field of topFields) {
    if (field.fieldNumber === 2) {
      if (field.wireType === 2) {
        const packed = decodePackedVarints(field.value);
        if (packed === null) {
          return null;
        }
        stepIndices.push(...packed);
      } else if (field.wireType === 0) {
        const step = toNonNegativeSafeInt(field.value);
        if (step === null) {
          return null;
        }
        stepIndices.push(step);
      }
    } else if (field.fieldNumber === 1 && field.wireType === 2) {
      chatMessageBytes = field.value;
    }
  }

  if (stepIndices.length === 0 || chatMessageBytes === null) {
    return null;
  }

  const chatFields = parseProtobufFields(chatMessageBytes);
  if (chatFields === null) {
    return null;
  }

  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null = null;
  let firstTokenLatencyMs: number | null = null;
  let rawDecodeMs: number | null = null;

  for (const field of chatFields) {
    if (field.fieldNumber === 4 && field.wireType === 2) {
      usage = decodeModelUsage(field.value);
      if (usage === null) {
        return null;
      }
    } else if (field.fieldNumber === 11 && field.wireType === 2) {
      const decoded = decodeProtobufDurationMs(field.value);
      if (!decoded.ok) {
        return null;
      }
      firstTokenLatencyMs = decoded.ms;
    } else if (field.fieldNumber === 12 && field.wireType === 2) {
      const decoded = decodeProtobufDurationMs(field.value);
      if (!decoded.ok) {
        return null;
      }
      rawDecodeMs = decoded.ms;
    }
  }

  if (usage === null) {
    return null;
  }

  const decodeDurationMs = usage.outputTokens > 0 ? rawDecodeMs : null;
  if (firstTokenLatencyMs === null && decodeDurationMs === null) {
    return null;
  }

  return {
    stepIndex: stepIndices[0],
    sample: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      firstTokenLatencyMs,
      decodeDurationMs
    }
  };
}

/**
 * Load per-step timing telemetry from `<account>/antigravity-acp/conversations/<session>.db`.
 * Returns an empty index on missing or unreadable databases so transcript
 * ingestion never fails when sibling telemetry is absent or still locked.
 */
export function loadAntigravitySessionTimings(conversationDbPath: string): AntigravityTimingIndex {
  if (!existsSync(conversationDbPath)) {
    return new Map();
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(conversationDbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: 1_000
    });
    const rows = db
      .prepare<{ data: Uint8Array | null }>("SELECT data FROM gen_metadata WHERE data IS NOT NULL")
      .all();

    const index = new Map<number, AntigravityTimingSample | null>();
    for (const row of rows) {
      if (!(row.data instanceof Uint8Array)) {
        continue;
      }
      const decoded = decodeAntigravityGenMetadataRow(row.data);
      if (decoded === null) {
        continue;
      }
      if (!index.has(decoded.stepIndex)) {
        index.set(decoded.stepIndex, decoded.sample);
      } else {
        const existing = index.get(decoded.stepIndex);
        if (existing !== null && existing !== undefined && !samplesEqual(existing, decoded.sample)) {
          index.set(decoded.stepIndex, null);
        }
      }
    }
    return index;
  } catch {
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors after a read failure.
    }
  }
}

export function matchAntigravityTiming(
  timings: AntigravityTimingIndex | undefined,
  input: {
    stepIndex: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  }
): { firstTokenLatencyMs: number | null; decodeDurationMs: number | null } | null {
  if (timings === undefined) {
    return null;
  }
  const sample = timings.get(input.stepIndex);
  if (sample === undefined || sample === null) {
    return null;
  }
  if (
    sample.inputTokens !== input.inputTokens ||
    sample.outputTokens !== input.outputTokens ||
    sample.cacheReadTokens !== input.cacheReadTokens
  ) {
    return null;
  }
  return {
    firstTokenLatencyMs: sample.firstTokenLatencyMs,
    decodeDurationMs: input.outputTokens > 0 ? sample.decodeDurationMs : null
  };
}

export async function readAntigravityTimingDbSignature(conversationDbPath: string): Promise<string> {
  const dbStat = await safeStat(conversationDbPath);
  if (dbStat === null) {
    return "";
  }
  const walStat = await safeStat(`${conversationDbPath}-wal`);
  const walSignature = walStat === null ? "none" : `${walStat.size}:${walStat.mtimeMs}`;
  return `${dbStat.size}:${dbStat.mtimeMs}|${walSignature}`;
}

async function safeStat(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const details = await stat(filePath);
    return { size: details.size, mtimeMs: details.mtimeMs };
  } catch {
    return null;
  }
}

function decodeModelUsage(
  bytes: Uint8Array
): { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null {
  const fields = parseProtobufFields(bytes);
  if (fields === null) {
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  for (const field of fields) {
    if (field.wireType !== 0) {
      continue;
    }
    if (field.fieldNumber === 2) {
      const value = toNonNegativeSafeInt(field.value);
      if (value === null) return null;
      inputTokens = value;
    } else if (field.fieldNumber === 3) {
      const value = toNonNegativeSafeInt(field.value);
      if (value === null) return null;
      outputTokens = value;
    } else if (field.fieldNumber === 5) {
      const value = toNonNegativeSafeInt(field.value);
      if (value === null) return null;
      cacheReadTokens = value;
    }
  }

  return { inputTokens, outputTokens, cacheReadTokens };
}

function decodeProtobufDurationMs(bytes: Uint8Array): { ok: true; ms: number | null } | { ok: false } {
  const fields = parseProtobufFields(bytes);
  if (fields === null) {
    return { ok: false };
  }

  let seconds = 0n;
  let nanos = 0n;

  for (const field of fields) {
    if (field.wireType !== 0) {
      continue;
    }
    if (field.fieldNumber === 1) {
      seconds = field.value;
    } else if (field.fieldNumber === 2) {
      nanos = field.value;
    }
  }

  // Reject both negative int64/int32 two's-complement varints and unreasonable spans.
  if (seconds > MAX_REASONABLE_DURATION_SECONDS || nanos >= NANOS_PER_SECOND) {
    return { ok: true, ms: null };
  }

  const ms = Math.round(Number(seconds) * 1000 + Number(nanos) / 1_000_000);
  return { ok: true, ms: ms > 0 ? ms : null };
}

function parseProtobufFields(data: Uint8Array): ProtobufField[] | null {
  const fields: ProtobufField[] = [];
  let offset = 0;

  while (offset < data.length) {
    const tag = readVarint(data, offset);
    if (tag === null) {
      return null;
    }
    offset = tag.nextOffset;

    const fieldNumber = tag.value >> 3n;
    const wireType = Number(tag.value & 7n);
    if (fieldNumber === 0n || fieldNumber > MAX_SAFE_INT_BIGINT) {
      return null;
    }

    const numericFieldNumber = Number(fieldNumber);
    if (wireType === 0) {
      const val = readVarint(data, offset);
      if (val === null) {
        return null;
      }
      offset = val.nextOffset;
      fields.push({ fieldNumber: numericFieldNumber, wireType: 0, value: val.value });
    } else if (wireType === 1) {
      if (offset + 8 > data.length) {
        return null;
      }
      offset += 8;
      fields.push({ fieldNumber: numericFieldNumber, wireType: 1 });
    } else if (wireType === 2) {
      const length = readVarint(data, offset);
      if (length === null || length.value > MAX_SAFE_INT_BIGINT) {
        return null;
      }
      const byteLength = Number(length.value);
      if (length.nextOffset + byteLength > data.length) {
        return null;
      }
      const value = data.subarray(length.nextOffset, length.nextOffset + byteLength);
      offset = length.nextOffset + byteLength;
      fields.push({ fieldNumber: numericFieldNumber, wireType: 2, value });
    } else if (wireType === 5) {
      if (offset + 4 > data.length) {
        return null;
      }
      offset += 4;
      fields.push({ fieldNumber: numericFieldNumber, wireType: 5 });
    } else {
      return null;
    }
  }

  return fields;
}

function decodePackedVarints(data: Uint8Array): number[] | null {
  const values: number[] = [];
  let offset = 0;

  while (offset < data.length) {
    const decoded = readVarint(data, offset);
    if (decoded === null) {
      return null;
    }
    const safe = toNonNegativeSafeInt(decoded.value);
    if (safe === null) {
      return null;
    }
    values.push(safe);
    offset = decoded.nextOffset;
  }

  return values;
}

function readVarint(
  data: Uint8Array,
  startOffset: number
): { value: bigint; nextOffset: number } | null {
  let result = 0n;
  let shift = 0n;

  for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
    const pos = startOffset + index;
    if (pos >= data.length) {
      return null;
    }
    const byte = data[pos];
    if (index === MAX_VARINT_BYTES - 1 && (byte & 0xfe) !== 0) {
      // A 10th byte with bits above bit 0 (or continuation bit set) overflows 64-bit unsigned varint.
      return null;
    }
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos + 1 };
    }
    shift += 7n;
  }

  return null;
}

function toNonNegativeSafeInt(value: bigint): number | null {
  return value >= 0n && value <= MAX_SAFE_INT_BIGINT ? Number(value) : null;
}

function samplesEqual(left: AntigravityTimingSample, right: AntigravityTimingSample): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.firstTokenLatencyMs === right.firstTokenLatencyMs &&
    left.decodeDurationMs === right.decodeDurationMs
  );
}
