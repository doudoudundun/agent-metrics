import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeAntigravityGenMetadataRow,
  loadAntigravitySessionTimings,
  matchAntigravityTiming,
  readAntigravityTimingDbSignature
} from "./antigravity-timing.js";

function varint(value: number | bigint): number[] {
  let n = BigInt(value);
  const out: number[] = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}

function fieldVarint(fieldNumber: number, value: number | bigint): number[] {
  return [...varint((fieldNumber << 3) | 0), ...varint(value)];
}

function fieldBytes(fieldNumber: number, payload: Uint8Array | number[]): number[] {
  const bytes = payload instanceof Uint8Array ? [...payload] : payload;
  return [...varint((fieldNumber << 3) | 2), ...varint(bytes.length), ...bytes];
}

function encodeDuration(seconds: number | bigint, nanos: number | bigint): number[] {
  return [
    ...(BigInt(seconds) !== 0n ? fieldVarint(1, seconds) : []),
    ...(BigInt(nanos) !== 0n ? fieldVarint(2, nanos) : [])
  ];
}

function encodeGenMetadata(input: {
  stepIndices: number[];
  packedSteps?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  omitUsage?: boolean;
  ttft?: { seconds: number | bigint; nanos: number | bigint } | null;
  stream?: { seconds: number | bigint; nanos: number | bigint } | null;
  model?: string;
}): Uint8Array {
  const usageBytes = [
    ...(input.inputTokens ? fieldVarint(2, input.inputTokens) : []),
    ...(input.outputTokens ? fieldVarint(3, input.outputTokens) : []),
    ...(input.cacheReadTokens ? fieldVarint(5, input.cacheReadTokens) : [])
  ];
  const chatBytes = [
    ...(!input.omitUsage ? fieldBytes(4, usageBytes) : []),
    ...(input.ttft ? fieldBytes(11, encodeDuration(input.ttft.seconds, input.ttft.nanos)) : []),
    ...(input.stream ? fieldBytes(12, encodeDuration(input.stream.seconds, input.stream.nanos)) : []),
    ...(input.model ? fieldBytes(19, Buffer.from(input.model, "utf8")) : [])
  ];
  const stepBytes = input.packedSteps
    ? fieldBytes(2, input.stepIndices.flatMap((step) => varint(step)))
    : input.stepIndices.flatMap((step) => fieldVarint(2, step));
  return Uint8Array.from([...stepBytes, ...fieldBytes(1, chatBytes)]);
}

describe("decodeAntigravityGenMetadataRow", () => {
  it("decodes packed step_indices, ModelUsage, TTFT, and streaming duration", () => {
    const blob = encodeGenMetadata({
      stepIndices: [7, 8],
      packedSteps: true,
      inputTokens: 4309,
      outputTokens: 1202,
      cacheReadTokens: 49456,
      ttft: { seconds: 5, nanos: 732_000_000 },
      stream: { seconds: 3, nanos: 312_000_000 },
      model: "gemini-4-hydrogen"
    });

    expect(decodeAntigravityGenMetadataRow(blob)).toEqual({
      stepIndex: 7,
      sample: {
        inputTokens: 4309,
        outputTokens: 1202,
        cacheReadTokens: 49456,
        firstTokenLatencyMs: 5732,
        decodeDurationMs: 3312
      }
    });
  });

  it("decodes unpacked repeated step_indices and proto3 omitted zero tokens", () => {
    const blob = encodeGenMetadata({
      stepIndices: [1, 2],
      packedSteps: false,
      inputTokens: 0,
      outputTokens: 25,
      cacheReadTokens: 0,
      ttft: { seconds: 0, nanos: 913_600_000 },
      stream: { seconds: 1, nanos: 0 }
    });

    expect(decodeAntigravityGenMetadataRow(blob)).toEqual({
      stepIndex: 1,
      sample: {
        inputTokens: 0,
        outputTokens: 25,
        cacheReadTokens: 0,
        firstTokenLatencyMs: 914,
        decodeDurationMs: 1000
      }
    });
  });

  it("rounds sub-millisecond durations and discards sub-0.5ms values", () => {
    const blob = encodeGenMetadata({
      stepIndices: [3],
      packedSteps: true,
      inputTokens: 10,
      outputTokens: 53,
      cacheReadTokens: 0,
      ttft: { seconds: 0, nanos: 200_000 },
      stream: { seconds: 0, nanos: 700_000 }
    });

    expect(decodeAntigravityGenMetadataRow(blob)).toEqual({
      stepIndex: 3,
      sample: {
        inputTokens: 10,
        outputTokens: 53,
        cacheReadTokens: 0,
        firstTokenLatencyMs: null,
        decodeDurationMs: 1
      }
    });
  });

  it("keeps decodeDurationMs null when outputTokens is zero", () => {
    const blob = encodeGenMetadata({
      stepIndices: [4],
      packedSteps: true,
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 50,
      ttft: { seconds: 1, nanos: 200_000_000 },
      stream: { seconds: 0, nanos: 500_000_000 }
    });

    expect(decodeAntigravityGenMetadataRow(blob)).toEqual({
      stepIndex: 4,
      sample: {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 50,
        firstTokenLatencyMs: 1200,
        decodeDurationMs: null
      }
    });

    const ttftMissingToo = encodeGenMetadata({
      stepIndices: [4],
      packedSteps: true,
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 50,
      ttft: null,
      stream: { seconds: 0, nanos: 500_000_000 }
    });
    expect(decodeAntigravityGenMetadataRow(ttftMissingToo)).toBeNull();
  });

  it("rejects negative or overflow durations", () => {
    const negativeDuration = encodeGenMetadata({
      stepIndices: [1],
      packedSteps: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      ttft: { seconds: 0xffffffffffffffffn, nanos: 0 },
      stream: { seconds: 86_401, nanos: 0 }
    });
    expect(decodeAntigravityGenMetadataRow(negativeDuration)).toBeNull();

    const overflowNanos = encodeGenMetadata({
      stepIndices: [1],
      packedSteps: true,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      ttft: { seconds: 2, nanos: 0 },
      stream: { seconds: 1, nanos: 1_000_000_000 }
    });
    expect(decodeAntigravityGenMetadataRow(overflowNanos)).toEqual({
      stepIndex: 1,
      sample: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        firstTokenLatencyMs: 2000,
        decodeDurationMs: null
      }
    });
  });

  it("rejects malformed or truncated protobuf payloads and missing required fields", () => {
    const valid = encodeGenMetadata({
      stepIndices: [1],
      packedSteps: true,
      inputTokens: 10,
      outputTokens: 5,
      ttft: { seconds: 1, nanos: 0 },
      stream: { seconds: 2, nanos: 0 }
    });
    expect(decodeAntigravityGenMetadataRow(valid.subarray(0, valid.length - 1))).toBeNull();
    expect(decodeAntigravityGenMetadataRow(Uint8Array.from([0x08]))).toBeNull(); // truncated varint
    expect(decodeAntigravityGenMetadataRow(Uint8Array.from([0x00, 0x01]))).toBeNull(); // fieldNumber 0
    expect(decodeAntigravityGenMetadataRow(Uint8Array.from([0x0b, 0x01]))).toBeNull(); // wireType 3
    expect(
      decodeAntigravityGenMetadataRow(
        encodeGenMetadata({
          stepIndices: [],
          packedSteps: true,
          inputTokens: 10,
          outputTokens: 5,
          ttft: { seconds: 1, nanos: 0 }
        })
      )
    ).toBeNull();
    expect(
      decodeAntigravityGenMetadataRow(
        encodeGenMetadata({
          stepIndices: [1],
          packedSteps: true,
          omitUsage: true,
          ttft: { seconds: 1, nanos: 0 }
        })
      )
    ).toBeNull();
  });
});

describe("loadAntigravitySessionTimings & matchAntigravityTiming", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agent-metrics-ag-timing-"));
    tempDirs.push(dir);
    return dir;
  }

  it("loads valid rows, rejects conflicting duplicate step_index, and verifies token counts", async () => {
    const dir = await createTempDir();
    const dbPath = join(dir, "session.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0)");

    const insert = db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 0)");
    const row1 = encodeGenMetadata({
      stepIndices: [1],
      packedSteps: true,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      ttft: { seconds: 1, nanos: 500_000_000 },
      stream: { seconds: 0, nanos: 800_000_000 }
    });
    // Identical duplicate on step 1 stays valid.
    insert.run(0, Buffer.from(row1));
    insert.run(1, Buffer.from(row1));

    // Conflicting duplicate on step 3 must invalidate step 3.
    insert.run(
      2,
      Buffer.from(
        encodeGenMetadata({
          stepIndices: [3],
          packedSteps: true,
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          ttft: { seconds: 1, nanos: 0 },
          stream: { seconds: 1, nanos: 0 }
        })
      )
    );
    insert.run(
      3,
      Buffer.from(
        encodeGenMetadata({
          stepIndices: [3],
          packedSteps: true,
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          ttft: { seconds: 2, nanos: 0 },
          stream: { seconds: 1, nanos: 0 }
        })
      )
    );
    db.close();

    const timings = loadAntigravitySessionTimings(dbPath);
    expect(
      matchAntigravityTiming(timings, {
        stepIndex: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 300
      })
    ).toEqual({ firstTokenLatencyMs: 1500, decodeDurationMs: 800 });

    // Token mismatches must never borrow timing.
    expect(
      matchAntigravityTiming(timings, {
        stepIndex: 1,
        inputTokens: 101,
        outputTokens: 20,
        cacheReadTokens: 300
      })
    ).toBeNull();
    expect(
      matchAntigravityTiming(timings, {
        stepIndex: 1,
        inputTokens: 100,
        outputTokens: 21,
        cacheReadTokens: 300
      })
    ).toBeNull();
    expect(
      matchAntigravityTiming(timings, {
        stepIndex: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 301
      })
    ).toBeNull();

    // Ambiguous step 3 is rejected.
    expect(timings.get(3)).toBeNull();
    expect(
      matchAntigravityTiming(timings, {
        stepIndex: 3,
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0
      })
    ).toBeNull();
  });

  it("returns an empty map for missing, table-less, or corrupt database files", async () => {
    const dir = await createTempDir();
    expect(loadAntigravitySessionTimings(join(dir, "missing.db")).size).toBe(0);

    const noTableDb = join(dir, "empty.db");
    const db = new Database(noTableDb);
    db.exec("CREATE TABLE other (id INTEGER)");
    db.close();
    expect(loadAntigravitySessionTimings(noTableDb).size).toBe(0);

    const corruptDb = join(dir, "corrupt.db");
    await writeFile(corruptDb, "not a sqlite file");
    expect(loadAntigravitySessionTimings(corruptDb).size).toBe(0);
  });

  it("includes both main db and wal metadata in the db signature", async () => {
    const dir = await createTempDir();
    const dbPath = join(dir, "session.db");
    expect(await readAntigravityTimingDbSignature(dbPath)).toBe("");

    await writeFile(dbPath, "db-content");
    const sigWithoutWal = await readAntigravityTimingDbSignature(dbPath);
    expect(sigWithoutWal.endsWith("|none")).toBe(true);

    await writeFile(`${dbPath}-wal`, "wal-content");
    const sigWithWal = await readAntigravityTimingDbSignature(dbPath);
    expect(sigWithWal).not.toBe(sigWithoutWal);
    expect(sigWithWal.endsWith("|none")).toBe(false);
  });
});
