import { mkdtemp, mkdir, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorkbuddyTimingLine, createWorkbuddyTimingReader, type WorkbuddyTimingIndex } from "./workbuddy-timing.js";
import { createWorkbuddyParseState, normalizeWorkbuddyRecord } from "./workbuddy.js";

const telemetry = {
  conversation_id: "session-1", conversation_request_id: "request-1", message_id: "message-1",
  trace_id: "trace-1", model: "deepseek-v4.1-flash", request_type: "chat", report_source: "agent-cli",
  finish_flag: "done", http_begin_status_code: "200", http_end_status_code: "200",
  model_error: "", model_error_code: "", total_cost_ms: "3015", ttft_ms: "1873",
  prompt_tokens: "34917", completion_tokens: "261", total_tokens: "35178"
};
const record = {
  type: "function_call", id: "call-record", timestamp: 1792463858535, callId: "call-1", name: "Read",
  providerData: {
    conversationRequestId: "request-1", messageId: "message-1", traceId: "trace-1", model: telemetry.model,
    usage: { requests: 1, inputTokens: 34917, outputTokens: 261, totalTokens: 35178 }
  }
};
const line = (changes = {}) => `[2026/10/20 10:37:38.397] [Info] [pid=31192] [ModelProvider]  [SseMonitor#01a1572b] qua.end: ${JSON.stringify({ ...telemetry, ...changes })}`;
function usage(index: WorkbuddyTimingIndex, input = record, session = "session-1") {
  return normalizeWorkbuddyRecord(input, session, ".", createWorkbuddyParseState(index))
    .find((event) => event.type === "token.usage.recorded");
}

describe("WorkBuddy model timing evidence", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("joins exact request/message/trace/model/tokens and excludes TTFT from decode time", () => {
    const index: WorkbuddyTimingIndex = new Map();
    collectWorkbuddyTimingLine(index, line());
    collectWorkbuddyTimingLine(index, line()); // identical mirrored telemetry is harmless
    expect(usage(index)).toMatchObject({ first_token_latency_ms: 1873, decode_duration_ms: 1142,
      input_tokens: 34917, output_tokens: 261 });
    expect(usage(index, record, "other-session")).toMatchObject({ decode_duration_ms: null });
    for (const changes of [{ traceId: "other" }, { conversationRequestId: "other" },
      { messageId: "other" }, { model: "other" },
      { usage: { ...record.providerData.usage, outputTokens: 260 } },
      { usage: { ...record.providerData.usage, requests: 2 } }]) {
      expect(usage(index, { ...record, providerData: { ...record.providerData, ...changes } }))
        .toMatchObject({ first_token_latency_ms: null, decode_duration_ms: null });
    }
  });

  it("accepts agent-team member telemetry with subagent request_type", () => {
    const index: WorkbuddyTimingIndex = new Map();
    collectWorkbuddyTimingLine(index, line({ request_type: "subagent:Explore" }));
    expect(usage(index)).toMatchObject({ first_token_latency_ms: 1873, decode_duration_ms: 1142 });
  });

  it.each([
    { ttft_ms: "" }, { ttft_ms: "0" }, { total_cost_ms: "1873" }, { total_cost_ms: "1800" },
    { finish_flag: "abort" }, { http_end_status_code: "500" }, { model_error: "error" },
    { request_type: "conversation_topic" }, { total_tokens: "35179" }, { ttft_ms: "1.2" }
  ])("excludes incomplete/failed/invalid telemetry: %j", (changes) => {
    const index: WorkbuddyTimingIndex = new Map();
    collectWorkbuddyTimingLine(index, line(changes));
    expect(usage(index)).toMatchObject({ first_token_latency_ms: null, decode_duration_ms: null });
  });

  it("rejects conflicting samples and embedded command output instead of guessing", () => {
    const index: WorkbuddyTimingIndex = new Map();
    collectWorkbuddyTimingLine(index, `tool output: ${line()}`);
    expect(index.size).toBe(0);
    collectWorkbuddyTimingLine(index, line());
    collectWorkbuddyTimingLine(index, line({ total_cost_ms: "3016" }));
    collectWorkbuddyTimingLine(index, line());
    expect(usage(index)).toMatchObject({ decode_duration_ms: null });
  });

  it("reads appended complete lines, resets replaced logs, and tolerates missing log directories", async () => {
    const home = await mkdtemp(join(tmpdir(), "workbuddy-timing-")); roots.push(home);
    const read = createWorkbuddyTimingReader();
    expect((await read(home)).index.size).toBe(0);
    const dir = join(home, "logs", "2026-10-20"); await mkdir(dir, { recursive: true });
    const path = join(dir, "workspace.log");
    await writeFile(path, line().slice(0, -10));
    expect((await read(home)).index.size).toBe(0);
    await appendFile(path, line().slice(-10) + "\r\n");
    const first = await read(home);
    expect(usage(first.index)).toMatchObject({ decode_duration_ms: 1142 });
    expect((await read(home)).signature).toBe(first.signature);
    await appendFile(path, line({ total_cost_ms: "3020" }) + "\n");
    expect(usage((await read(home)).index)).toMatchObject({ decode_duration_ms: null });
    await writeFile(path, line() + "\n");
    expect(usage((await read(home)).index)).toMatchObject({ decode_duration_ms: 1142 });
  });
});
