import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

type TimingSample = {
  model: string;
  traceId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  firstTokenLatencyMs: number;
  decodeDurationMs: number;
};

export type WorkbuddyTimingIndex = Map<string, TimingSample | null>;

type CachedLog = {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  offset: number;
  samples: WorkbuddyTimingIndex;
};

/** Only model-level telemetry is accepted. SDK dispatch/usage notifications can
 * be replayed after tools finish and do not identify a model's decode interval. */
export function collectWorkbuddyTimingLine(index: WorkbuddyTimingIndex, line: string): void {
  const match = /^\[[^\]]+\] \[Info\] \[pid=\d+\] \[ModelProvider\]\s+\[SseMonitor#[^\]]+\] qua\.end: (\{.*\})\r?$/u.exec(line);
  if (match === null) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return;
  }
  const session = readString(data.conversation_id);
  const request = readString(data.conversation_request_id);
  const message = readString(data.message_id);
  if (session === null || request === null || message === null) return;

  const totalMs = readInt(data.total_cost_ms);
  const ttftMs = readInt(data.ttft_ms);
  const inputTokens = readInt(data.prompt_tokens);
  const outputTokens = readInt(data.completion_tokens);
  const totalTokens = readInt(data.total_tokens);
  const model = readString(data.model);
  const traceId = readString(data.trace_id);
  const requestType = readString(data.request_type);
  const valid = (requestType === "chat" || (requestType !== null && requestType.startsWith("subagent:"))) &&
    data.report_source === "agent-cli" &&
    data.finish_flag === "done" && data.http_begin_status_code === "200" &&
    data.http_end_status_code === "200" && data.model_error === "" && data.model_error_code === "" &&
    totalMs !== null && ttftMs !== null && ttftMs > 0 && totalMs > ttftMs &&
    inputTokens !== null && outputTokens !== null && outputTokens > 0 && totalTokens !== null &&
    totalTokens === inputTokens + outputTokens && model !== null && traceId !== null;
  const sample: TimingSample | null = valid ? {
    model, traceId, inputTokens, outputTokens, totalTokens,
    firstTokenLatencyMs: ttftMs,
    // Both values belong to this model request; waiting for tools is excluded.
    decodeDurationMs: totalMs - ttftMs
  } : null;
  mergeSample(index, timingKey(session, request, message), sample);
}

export function matchWorkbuddyTiming(
  index: WorkbuddyTimingIndex | undefined,
  sessionId: string,
  providerData: Record<string, unknown>,
  usage: Record<string, unknown>
): Pick<TimingSample, "firstTokenLatencyMs" | "decodeDurationMs"> | null {
  const request = readString(providerData.conversationRequestId);
  const message = readString(providerData.messageId);
  if (index === undefined || request === null || message === null) return null;
  const sample = index.get(timingKey(sessionId, request, message));
  if (sample == null || usage.requests !== 1 || sample.model !== providerData.model ||
      sample.traceId !== providerData.traceId || sample.inputTokens !== usage.inputTokens ||
      sample.outputTokens !== usage.outputTokens || sample.totalTokens !== usage.totalTokens) return null;
  return sample;
}

/** A reader owns its cache. Files are consumed incrementally at complete-line
 * boundaries, so a delayed/partial qua.end is picked up without rereading logs. */
export function createWorkbuddyTimingReader(): (homePath: string) => Promise<{
  index: WorkbuddyTimingIndex;
  signature: string;
}> {
  let cachedHome: string | null = null;
  const files = new Map<string, CachedLog>();
  return async (homePath) => {
    if (cachedHome !== homePath) {
      files.clear();
      cachedHome = homePath;
    }
    const paths: string[] = [];
    const logsRoot = join(homePath, "logs");
    for (const day of await readDirectory(logsRoot)) {
      if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/u.test(day.name)) continue;
      const dayPath = join(logsRoot, day.name);
      for (const file of await readDirectory(dayPath)) {
        if (file.isFile() && file.name.endsWith(".log")) paths.push(join(dayPath, file.name));
      }
    }
    paths.sort();
    const active = new Set(paths);
    for (const path of files.keys()) if (!active.has(path)) files.delete(path);
    const index: WorkbuddyTimingIndex = new Map();
    for (const path of paths) {
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      let cached = files.get(path);
      if (cached === undefined || info.birthtimeMs !== cached.birthtimeMs ||
          info.size < cached.size || (info.size === cached.size && info.mtimeMs !== cached.mtimeMs)) {
        cached = { size: 0, mtimeMs: 0, birthtimeMs: info.birthtimeMs, offset: 0, samples: new Map() };
        files.set(path, cached);
      }
      if (info.size > cached.offset && (info.size !== cached.size || info.mtimeMs !== cached.mtimeMs)) {
        await readCompleteLines(path, cached, info.size);
      }
      cached.size = info.size;
      cached.mtimeMs = info.mtimeMs;
      for (const [key, sample] of cached.samples) mergeSample(index, key, sample);
    }
    // Unrelated diagnostics grow frequently; rescan transcripts only when the
    // timing evidence changes, rather than on every log write.
    const signature = createHash("sha256")
      .update(JSON.stringify([...index].sort(([left], [right]) => left.localeCompare(right))))
      .digest("hex");
    return { index, signature };
  };
}

async function readCompleteLines(path: string, cached: CachedLog, size: number): Promise<void> {
  const stream = createReadStream(path, { start: cached.offset, end: size - 1 });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const buffer = pending.length === 0 ? chunk as Buffer : Buffer.concat([pending, chunk]);
      let start = 0;
      let end: number;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        collectWorkbuddyTimingLine(cached.samples, buffer.subarray(start, end).toString("utf8"));
        cached.offset += end + 1 - start;
        start = end + 1;
      }
      pending = Buffer.from(buffer.subarray(start));
    }
  } finally {
    stream.destroy();
  }
}

function mergeSample(index: WorkbuddyTimingIndex, key: string, sample: TimingSample | null): void {
  if (!index.has(key)) index.set(key, sample);
  else if (JSON.stringify(index.get(key)) !== JSON.stringify(sample)) index.set(key, null);
}

function timingKey(session: string, request: string, message: string): string {
  return JSON.stringify([session, request, message]);
}

function readInt(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
