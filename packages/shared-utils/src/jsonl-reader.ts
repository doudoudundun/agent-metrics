import { createReadStream } from "node:fs";

/** Read a fixed byte range without decoding or allocating the historical prefix. */
export async function* readJsonlLines(input: {
  filePath: string;
  start?: number;
  end: number;
  includeUnterminated?: boolean;
  maxLineBytes?: number;
}): AsyncGenerator<{ line: string; nextOffset: number; complete: boolean }> {
  const start = input.start ?? 0;
  // Image tool results can exceed 16 MiB. Keep a finite per-record ceiling,
  // independent of the total file size and the caller's per-batch budget.
  const maxLineBytes = input.maxLineBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
  if (start >= input.end) return;
  const stream = createReadStream(input.filePath, {
    start, end: input.end - 1, highWaterMark: 64 * 1024
  });
  let fragments: Buffer[] = [];
  let lineBytes = 0;
  let offset = start;
  function append(fragment: Buffer): void {
    lineBytes += fragment.length;
    if (lineBytes > maxLineBytes) {
      throw Object.assign(new Error("JSONL record exceeds configured byte limit"), {
        code: "JSONL_LINE_TOO_LARGE"
      });
    }
    if (fragment.length) fragments.push(fragment);
  }
  function decode(): string {
    // Concatenate once per record; repeatedly copying its growing prefix is quadratic.
    return (fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, lineBytes)).toString("utf8");
  }
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      let from = 0;
      let newline: number;
      while ((newline = bytes.indexOf(0x0a, from)) !== -1) {
        append(bytes.subarray(from, newline));
        offset += lineBytes + 1;
        const line = decode();
        fragments = [];
        lineBytes = 0;
        yield { line, nextOffset: offset, complete: true };
        from = newline + 1;
      }
      append(bytes.subarray(from));
    }
    if (input.includeUnterminated && lineBytes) {
      yield { line: decode(), nextOffset: offset + lineBytes, complete: false };
    }
  } finally {
    stream.destroy();
  }
}
