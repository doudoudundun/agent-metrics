import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { normalize, resolve } from "node:path";

export const PREFIX_HASH_BYTES = 4 * 1024;

type CursorLike = {
  fileIdentity: string;
  committedOffset: number;
  committedPrefixHash: string;
};

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function computeFileIdentityFromHandle(
  filePath: string,
  handle: FileHandle,
  details: Awaited<ReturnType<FileHandle["stat"]>>
): Promise<string> {
  const fileSize = statNumber(details.size, "file size");
  const identity = {
    canonicalPath: canonicalPath(filePath),
    creationTime: stableCreationTime(details.birthtimeMs),
    first4KiBHash: sha256Hex(await readRange(handle, 0, Math.min(PREFIX_HASH_BYTES, fileSize)))
  };
  return sha256Hex(canonicalJson(identity));
}

export async function cursorMatchesFile(
  cursor: CursorLike,
  fileIdentity: string,
  fileSize: number,
  handle: FileHandle
): Promise<boolean> {
  if (
    cursor.fileIdentity !== fileIdentity ||
    !Number.isSafeInteger(cursor.committedOffset) ||
    cursor.committedOffset < 0 ||
    cursor.committedOffset > fileSize ||
    typeof cursor.committedPrefixHash !== "string"
  ) {
    return false;
  }
  const expectedHash = await hashRange(
    handle,
    cursor.committedOffset - Math.min(cursor.committedOffset, PREFIX_HASH_BYTES),
    cursor.committedOffset
  );
  return expectedHash === cursor.committedPrefixHash;
}

export async function hashRange(handle: FileHandle, startOffset: number, endOffset: number): Promise<string> {
  if (endOffset <= startOffset) {
    return sha256Hex(Buffer.alloc(0));
  }
  return sha256Hex(await readRange(handle, startOffset, endOffset - startOffset));
}

export async function readRange(handle: FileHandle, startOffset: number, length: number): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const output = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const result = await handle.read(output, total, length - total, startOffset + total);
    if (result.bytesRead === 0) {
      break;
    }
    total += result.bytesRead;
  }
  return output.subarray(0, total);
}

export function decodeLine(value: Uint8Array, stripCarriageReturn = true): string {
  const decoded = Buffer.from(value).toString("utf8");
  return stripCarriageReturn && decoded.endsWith("\r") ? decoded.slice(0, -1) : decoded;
}

function canonicalPath(filePath: string): string {
  const resolved = normalize(resolve(filePath));
  return process.platform === "win32" ? resolved.replaceAll("\\", "/") : resolved;
}

function canonicalJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value)
    .sort(compareNames)
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
    .join(",")}}`;
}

function stableCreationTime(value: number | bigint): number | null {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(normalized) ? normalized : null;
}

function statNumber(value: number | bigint, label: string): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return normalized;
}

export function normalizeNow(value?: number | Date): number {
  const normalized = value instanceof Date ? value.getTime() : value ?? Date.now();
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new RangeError("now must be a non-negative finite timestamp");
  }
  return Math.trunc(normalized);
}

export function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

