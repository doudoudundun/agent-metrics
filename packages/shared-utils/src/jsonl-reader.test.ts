import { appendFile, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readJsonlLines } from "./jsonl-reader.js";

describe("readJsonlLines", () => {
  it("enforces byte limits even when the complete record fits inside a single chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "metrics-jsonl-"));
    try {
      const filePath = join(root, "events.jsonl");
      for (const suffix of ["", "\n"]) {
        await writeFile(filePath, "中文" + suffix);
        const read = async (maxLineBytes: number) => {
          const result = [];
          for await (const entry of readJsonlLines({ filePath, end: (await stat(filePath)).size,
            includeUnterminated: true, maxLineBytes })) result.push(entry);
          return result;
        };
        await expect(read(5)).rejects.toMatchObject({ code: "JSONL_LINE_TOO_LARGE" });
        expect(await read(6)).toEqual([{ line: "中文", nextOffset: 6 + suffix.length, complete: !!suffix }]);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps exact offsets across blank lines, large records, partial tails and later appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "metrics-jsonl-"));
    try {
      const filePath = join(root, "events.jsonl");
      const large = "a".repeat(17 * 1024 * 1024) + "中文";
      await writeFile(filePath, "\n" + large + "\npartial");
      const read = async (start = 0) => {
        const result = [];
        for await (const entry of readJsonlLines({ filePath, start, end: (await stat(filePath)).size,
          includeUnterminated: true })) result.push(entry);
        return result;
      };
      const result = await read();
      const offset = Buffer.byteLength(large) + 2;
      expect(result).toEqual([
        { line: "", nextOffset: 1, complete: true },
        { line: large, nextOffset: offset, complete: true },
        { line: "partial", nextOffset: offset + 7, complete: false }
      ]);
      await appendFile(filePath, " tail\n");
      expect(await read(offset)).toEqual([{ line: "partial tail", nextOffset: offset + 13, complete: true }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reads only the tail of a sparse file larger than the JS string limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "metrics-jsonl-"));
    try {
      const filePath = join(root, "events.jsonl");
      const start = 1024 * 1024 * 1024;
      const tail = Buffer.from('{"text":"中文"}\n{"pending":');
      const file = await open(filePath, "w");
      await file.write(tail, 0, tail.length, start);
      await file.close();
      const result = [];
      for await (const line of readJsonlLines({ filePath, start, end: (await stat(filePath)).size })) result.push(line);
      expect(result).toEqual([{ line: '{"text":"中文"}', nextOffset: start + Buffer.byteLength('{"text":"中文"}\n'), complete: true }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves multibyte text split across read chunks and never consumes a partial tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "metrics-jsonl-"));
    try {
      const filePath = join(root, "events.jsonl");
      const text = 'a'.repeat(65535) + '中文\n';
      await writeFile(filePath, text + 'partial');
      const result = [];
      for await (const line of readJsonlLines({ filePath, end: (await stat(filePath)).size })) result.push(line);
      expect(result).toHaveLength(1);
      expect(result[0].line).toBe(text.trimEnd());
      expect(result[0].nextOffset).toBe(Buffer.byteLength(text));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
