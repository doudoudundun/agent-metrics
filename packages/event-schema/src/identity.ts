import type { NormalizedEventV2 } from "./events.js";

export type EventIdentityInput = {
  sourceInstanceId: string;
  sourceRecordNamespace: string;
  eventKind: string;
  sessionId: string;
  sourceRecordId?: string | null;
  timestamp?: string | Date;
  sourceSequence?: string | number | null;
  location?: unknown;
  canonicalIdentityFields?: Record<string, unknown>;
};

export type ToolCallIdentityInput = {
  sourceInstanceId: string;
  sessionId: string;
  timestamp: string | Date;
  sourceSequence?: string | number | null;
  toolName: string;
  sourceLocation: unknown;
};

/**
 * Serialize JSON with recursively sorted object keys. The event identity
 * inputs are restricted to JSON-compatible values, so this is the RFC 8785
 * subset needed by the local telemetry identity boundary.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Identity values must contain finite numbers");
    }

    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJson(entry)}`)
      .join(",")}}`;
  }

  throw new TypeError("Identity values must be JSON-compatible");
}

export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ];

  for (let blockOffset = 0; blockOffset < paddedLength; blockOffset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(blockOffset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15];
      const second = words[index - 2];
      const smallSigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const smallSigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = (words[index - 16] + smallSigma0 + words[index - 7] + smallSigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const firstSum = (h + bigSigma1 + choose + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const secondSum = (bigSigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + firstSum) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (firstSum + secondSum) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2
];

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export function normalizeEventTimestamp(value: string | Date): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("Event timestamp must be a valid RFC 3339 timestamp");
  }

  return date.toISOString();
}

/**
 * Normalize separators and redundant dot segments without resolving `..`,
 * following the spec's requirement to preserve the source path's meaning.
 */
export function normalizeWorkspacePath(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    return ".";
  }

  const path = value.replaceAll("\\", "/");
  const isUnc = path.startsWith("//");
  const driveMatch = /^([a-zA-Z]):(?:\/|$)/.exec(path);
  const isPosixAbsolute = path.startsWith("/") && !isUnc;
  const body = isUnc
    ? path.slice(2)
    : driveMatch
      ? path.slice(2)
      : isPosixAbsolute
        ? path.slice(1)
        : path;
  const segments = body.split("/").filter((segment) => segment.length > 0 && segment !== ".");

  if (isUnc) {
    return segments.length === 0 ? "//" : `//${segments.join("/")}`;
  }

  if (driveMatch) {
    return segments.length === 0
      ? `${driveMatch[1].toUpperCase()}:/`
      : `${driveMatch[1].toUpperCase()}:/${segments.join("/")}`;
  }

  if (isPosixAbsolute) {
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
  }

  return segments.length === 0 ? "." : segments.join("/");
}

export function normalizeNativeId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length === 0 ? null : `native:${trimmed}`;
}

export function createEventId(input: EventIdentityInput): string {
  assertIdentifier(input.sourceInstanceId, "sourceInstanceId");
  assertIdentifier(input.sourceRecordNamespace, "sourceRecordNamespace");
  assertIdentifier(input.eventKind, "eventKind");
  assertIdentifier(input.sessionId, "sessionId");

  const sourceRecordId = normalizeOptionalId(input.sourceRecordId);
  const identity = sourceRecordId
    ? {
        sessionId: input.sessionId,
        sourceInstanceId: input.sourceInstanceId,
        sourceRecordId
      }
    : input.canonicalIdentityFields ?? {
        eventKind: input.eventKind,
        location: input.location ?? null,
        sessionId: input.sessionId,
        sourceInstanceId: input.sourceInstanceId,
        sourceRecordNamespace: input.sourceRecordNamespace,
        sourceSequence: input.sourceSequence ?? null,
        timestamp: input.timestamp === undefined ? null : normalizeEventTimestamp(input.timestamp)
      };

  return `v2:${input.sourceInstanceId}:${input.sourceRecordNamespace}:${input.eventKind}:${sha256Hex(
    canonicalizeJson(identity)
  )}`;
}

export function semanticFingerprint(event: NormalizedEventV2 | Record<string, unknown>): string {
  const { source_adapter: _sourceAdapter, adapter_instance_id: _adapterInstanceId, ...semantic } =
    event as Record<string, unknown>;
  return sha256Hex(canonicalizeJson(semantic));
}

export function deriveToolCallId(input: ToolCallIdentityInput): string {
  assertIdentifier(input.sourceInstanceId, "sourceInstanceId");
  assertIdentifier(input.sessionId, "sessionId");
  assertIdentifier(input.toolName, "toolName");

  return `derived:${sha256Hex(
    canonicalizeJson({
      sessionId: input.sessionId,
      sourceInstanceId: input.sourceInstanceId,
      sourceLocation: input.sourceLocation,
      sourceSequence: input.sourceSequence ?? null,
      timestamp: normalizeEventTimestamp(input.timestamp),
      toolName: input.toolName
    })
  )}`;
}

export function legacyToolCallId(eventId: string): string {
  assertIdentifier(eventId, "eventId");
  return `legacy:${eventId}`;
}

function normalizeOptionalId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length === 0 ? null : trimmed;
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
