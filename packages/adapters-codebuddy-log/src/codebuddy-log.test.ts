import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolateSources, type IsolatedSources } from "@agent-metrics/test-utils";
import { parseCodebuddyLog } from "./codebuddy-log.js";
import { resolveCodebuddyLogRoots, syncCodebuddyCliLogs } from "./codebuddy-log-sync.js";

const SESSION_ID = "01a17b4a-67d4-76a4-a2e5-4f881d0ff417";
const TURN_ID = "01a17b4a68ad7d248b2e1b97a659c4e7";

type QuaEndOptions = {
  messageId: string;
  requestId?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
};

function quaEndLine(options: QuaEndOptions, at = "10:57:36.264"): string {
  const payload = {
    conversation_id: SESSION_ID,
    conversation_request_id: options.requestId ?? TURN_ID,
    message_id: options.messageId,
    model: options.model ?? "deepseek-v4.1-flash",
    request_type: "chat",
    report_source: "agent-cli",
    http_end_status_code: "200",
    finish_reason: "stop",
    total_cost_ms: "18752",
    ttft_ms: "2431",
    completion_tokens: String(options.completionTokens ?? 152),
    prompt_tokens: String(options.promptTokens ?? 24733),
    total_tokens: String((options.promptTokens ?? 24733) + (options.completionTokens ?? 152))
  };
  return `[2026/10/27 ${at}] [Info] [pid=98820] [ModelProvider]  [SseMonitor#01a17b4a] qua.end: ${JSON.stringify(payload)}`;
}

function creditLine(
  requestId: string,
  credit: string,
  at = "10:57:36.275",
  source = "raw_model_stream_event"
): string {
  return `[2026/10/27 ${at}] [Info] [pid=98820] [SessionManager][credit] Credit received: rootRequestId=${requestId}, source=${source}, credit=${credit}`;
}

function workspaceLine(): string {
  return `[2026/10/27 10:57:16.317] [Info] [pid=98820] [waitFor] Registered mainSession: id=${SESSION_ID}, meta={"cwd":"d:\\\\projects\\\\dev\\\\demo"}`;
}

type ModelCallOptions = {
  inputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  sessionId?: string;
};

function modelCallLine(options: ModelCallOptions, at = "10:57:36.267"): string {
  const payload = {
    model: "deepseek-v4.1-flash",
    step: 1,
    attempt_no: 1,
    time_to_first_token_ms: 2431,
    input_tokens: options.inputTokens,
    output_tokens: 152,
    total_tokens: options.inputTokens + 152,
    cached_read_tokens: options.cachedReadTokens,
    cached_write_tokens: options.cachedWriteTokens ?? 0,
    finish_reason: "stop",
    event_name: "agent.model_call.completed",
    conversation_id: options.sessionId ?? SESSION_ID,
    conversation_request_id: TURN_ID
  };
  return `[2026/10/27 ${at}] [Info] [pid=98820] [ModelProvider]  ${JSON.stringify(payload)}`;
}

describe("parseCodebuddyLog", () => {
  it.each([
    ["11/1/2026, 10:45:03 PM.483", 22, 483],
    ["11/1/2026, 12:45:03 AM.007", 0, 7],
    ["11/1/2026, 12:45:03 PM", 12, 0]
  ] as const)("reads native WorkBuddy locale timestamps: %s", (stamp, hour, millis) => {
    const line = quaEndLine({ messageId: "native" }).replace(/^\[[^\]]+\]/u, `[${stamp}]`);
    const scan = parseCodebuddyLog(line, ".");
    expect(scan.requests).toHaveLength(1);
    expect(scan.requests[0]?.timestamp).toBe(new Date(2026, 10, 1, hour, 45, 3, millis).getTime());
  });

  it("pairs each credit line with the request that precedes it", () => {
    const text = [
      workspaceLine(),
      quaEndLine({ messageId: "msg_a" }),
      creditLine(TURN_ID, "0.05"),
      quaEndLine({ messageId: "msg_b" }),
      creditLine(TURN_ID, "0.12")
    ].join("\n");

    const scan = parseCodebuddyLog(text, ".");

    expect(scan.requests).toHaveLength(2);
    expect(scan.requests[0]).toMatchObject({
      messageId: "msg_a",
      sessionId: SESSION_ID,
      credit: 0.05,
      promptTokens: 24733,
      completionTokens: 152,
      workspacePath: "D:/projects/dev/demo"
    });
    expect(scan.requests[1]).toMatchObject({ messageId: "msg_b", credit: 0.12 });
  });

  it("pairs a credit line that the CLI flushed before its qua.end", () => {
    const text = [
      workspaceLine(),
      creditLine(TURN_ID, "0.07"),
      quaEndLine({ messageId: "msg_a" })
    ].join("\n");

    const scan = parseCodebuddyLog(text, ".");

    expect(scan.requests).toHaveLength(1);
    expect(scan.requests[0]?.credit).toBe(0.07);
  });

  it("ignores the amountless response_done line so it cannot shift credit", () => {
    const text = [
      quaEndLine({ messageId: "msg_a" }),
      creditLine(TURN_ID, "undefined", "10:57:36.275", "response_done"),
      quaEndLine({ messageId: "msg_b" }),
      creditLine(TURN_ID, "0.3")
    ].join("\n");

    const scan = parseCodebuddyLog(text, ".");

    expect(scan.requests[0]?.credit).toBe(0.3);
    expect(scan.requests[1]?.credit).toBeNull();
  });

  it("drops requests that consumed no tokens", () => {
    const text = quaEndLine({ messageId: "msg_a", promptTokens: 0, completionTokens: 0 });
    expect(parseCodebuddyLog(text, ".").requests).toHaveLength(0);
  });

  it("attaches provider cache figures to the call they bill", () => {
    const text = [
      workspaceLine(),
      quaEndLine({ messageId: "msg_a", promptTokens: 24733 }),
      modelCallLine({ inputTokens: 24733, cachedReadTokens: 24000 })
    ].join("\n");

    const scan = parseCodebuddyLog(text, ".");

    expect(scan.requests[0]).toMatchObject({
      messageId: "msg_a",
      promptTokens: 24733,
      cacheReadTokens: 24000
    });
  });

  it("matches a cache line to the call with the same prompt size", () => {
    const text = [
      quaEndLine({ messageId: "msg_a", promptTokens: 1000 }, "10:57:36.100"),
      quaEndLine({ messageId: "msg_b", promptTokens: 2000 }, "10:57:37.100"),
      modelCallLine({ inputTokens: 2000, cachedReadTokens: 1900 }, "10:57:37.110"),
      modelCallLine({ inputTokens: 1000, cachedReadTokens: 900 }, "10:57:36.110")
    ].join("\n");

    const scan = parseCodebuddyLog(text, ".");
    const byMessage = new Map(scan.requests.map((request) => [request.messageId, request]));

    expect(byMessage.get("msg_a")?.cacheReadTokens).toBe(900);
    expect(byMessage.get("msg_b")?.cacheReadTokens).toBe(1900);
  });

  it("keeps cache read within the prompt it was measured against", () => {
    const text = [
      quaEndLine({ messageId: "msg_a", promptTokens: 1000 }),
      modelCallLine({ inputTokens: 1000, cachedReadTokens: 5000 })
    ].join("\n");

    expect(parseCodebuddyLog(text, ".").requests[0]?.cacheReadTokens).toBe(1000);
  });

  it("leaves cache at zero when the provider layer logged no figures", () => {
    const scan = parseCodebuddyLog(quaEndLine({ messageId: "msg_a" }), ".");
    expect(scan.requests[0]?.cacheReadTokens).toBe(0);
  });

  it("keeps the cache read unknown when the telemetry line omits it", () => {
    const telemetry = modelCallLine({ inputTokens: 24733 });
    const scan = parseCodebuddyLog(
      [quaEndLine({ messageId: "msg_a", promptTokens: 24733 }), telemetry].join("\n"),
      "."
    );
    expect(scan.requests[0]).toMatchObject({ cacheReadTokens: 0, cacheReadReported: false });
  });

  it("keeps a reported zero cache read as a measured miss", () => {
    const text = [
      quaEndLine({ messageId: "msg_a", promptTokens: 24733 }),
      modelCallLine({ inputTokens: 24733, cachedReadTokens: 0 })
    ].join("\n");

    expect(parseCodebuddyLog(text, ".").requests[0]).toMatchObject({
      cacheReadTokens: 0,
      cacheReadReported: true
    });
  });

  it("keeps a single record per message id", () => {
    const text = [
      quaEndLine({ messageId: "msg_a" }),
      creditLine(TURN_ID, "0.05"),
      quaEndLine({ messageId: "msg_a" }, "10:58:00.000"),
      creditLine(TURN_ID, "0.07")
    ].join("\n");

    const scan = parseCodebuddyLog(text, ".");

    expect(scan.requests).toHaveLength(1);
  });

  it("falls back to the log path slug when the session header is missing", () => {
    const scan = parseCodebuddyLog(quaEndLine({ messageId: "msg_a" }), "D:/fallback");
    expect(scan.requests[0]?.workspacePath).toBe("D:/fallback");
  });
});

describe("syncCodebuddyCliLogs", () => {
  let isolated: IsolatedSources | null = null;
  const roots: string[] = [];

  beforeEach(async () => {
    isolated = await isolateSources();
  });

  afterEach(async () => {
    isolated?.cleanup();
    isolated = null;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function writeLog(
    root: string,
    body: string,
    options: { terminated?: boolean } = {}
  ): Promise<string> {
    const logRoot = join(root, "logs");
    const dayDir = join(logRoot, "2026-10-27");
    await mkdir(dayDir, { recursive: true });
    const logPath = join(dayDir, "d-projects-dev-demo__cc63707d9.log");
    // The CLI terminates every record with a newline; a file without the
    // trailing newline is treated as still being written.
    const terminated = options.terminated ?? true;
    const contents = terminated && !body.endsWith("\n") ? `${body}\n` : body;
    await writeFile(logPath, contents);
    return logRoot;
  }

  function readEvents(path: string): Array<Record<string, unknown>> {
    return readFile(path, "utf8")
      .then(() => undefined)
      .catch(() => undefined)
      .then(async () => {
        const contents = await readFile(path, "utf8");
        return contents
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      });
  }

  it("writes session and usage events once, then stays idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(
      root,
      [workspaceLine(), quaEndLine({ messageId: "msg_a" }), creditLine(TURN_ID, "0.05")].join("\n")
    );
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor.json");
    const ledgerPath = join(root, "ledger.json");

    const first = await syncCodebuddyCliLogs({
      eventLogPath,
      cursorPath,
      ledgerPath,
      logRoot,
      settleMs: 0
    });
    expect(first.requestsWritten).toBe(1);

    const events = await readEvents(eventLogPath);
    const usage = events.find((event) => event.type === "token.usage.recorded");
    expect(usage).toMatchObject({
      session_id: SESSION_ID,
      source_vendor: "workbuddy",
      source_adapter: "codebuddy-cli-log",
      usage_source: "codebuddy-log",
      input_tokens: 24733,
      output_tokens: 152,
      credit: 0.05,
      input_token_semantics: "gross"
    });
    expect(events.some((event) => event.type === "session.started")).toBe(true);

    const second = await syncCodebuddyCliLogs({
      eventLogPath,
      cursorPath,
      ledgerPath,
      logRoot,
      settleMs: 0
    });
    expect(second.requestsWritten).toBe(0);
    expect((await readEvents(eventLogPath))).toHaveLength(events.length);
  });

  it("collects headless WorkBuddy logs alongside CodeBuddy without double counting", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-workbuddy-cli-log-"));
    roots.push(root);
    const codebuddyHome = join(root, "codebuddy");
    const workbuddyHome = join(root, "workbuddy");
    const logRoot = await writeLog(codebuddyHome, quaEndLine({ messageId: "shared" }));
    const nativeLog = [
      workspaceLine(),
      quaEndLine({ messageId: "shared" }),
      quaEndLine({ messageId: "headless", promptTokens: 25000, completionTokens: 200 }),
      modelCallLine({ inputTokens: 25000, cachedReadTokens: 24000 })
    ].join("\n").replace(/\[2026\/10\/27 10:57:36\.\d+\]/gu, "[11/1/2026, 10:45:03 PM.483]");
    await writeLog(workbuddyHome, nativeLog);
    process.env.AGENT_METRICS_CODEBUDDY_LOG_ROOT = logRoot;
    process.env.AGENT_METRICS_WORKBUDDY_HOME = workbuddyHome;
    const input = {
      eventLogPath: join(root, "events.jsonl"),
      cursorPath: join(root, "cursor.json"),
      ledgerPath: join(root, "ledger.json")
    };

    const first = await syncCodebuddyCliLogs(input);
    expect(first.filesScanned).toBe(2);
    expect(first.requestsWritten).toBe(2);
    const usage = (await readEvents(input.eventLogPath)).filter((event) => event.type === "token.usage.recorded");
    expect(usage).toHaveLength(2);
    expect(usage.find((event) => event.message_id === "headless")).toMatchObject({
      source_vendor: "workbuddy", input_tokens: 25000, output_tokens: 200,
      cache_read_input_tokens: 24000, workspace_path: "D:/projects/dev/demo"
    });
    expect(usage.every((event) => event.credit === undefined)).toBe(true);
    expect((await syncCodebuddyCliLogs(input)).requestsWritten).toBe(0);
    expect((await syncCodebuddyCliLogs({ ...input, logRoot })).filesScanned).toBe(0);
    expect(resolveCodebuddyLogRoots({ logRoot })).toEqual([logRoot]);
    process.env.AGENT_METRICS_WORKBUDDY_HOME = codebuddyHome;
    expect(resolveCodebuddyLogRoots()).toEqual([logRoot]);
  });

  it("disables the quiet period at zero even when the file timestamp is ahead of the clock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(root, quaEndLine({ messageId: "msg_a" }));
    const logPath = join(logRoot, "2026-10-27", "d-projects-dev-demo__cc63707d9.log");
    const future = new Date(Date.now() + 60_000);
    await utimes(logPath, future, future);
    const input = {
      eventLogPath: join(root, "events.jsonl"),
      cursorPath: join(root, "cursor.json"),
      ledgerPath: join(root, "ledger.json"),
      logRoot
    };

    expect((await syncCodebuddyCliLogs({ ...input, settleMs: 1_000 })).requestsWritten).toBe(0);
    expect((await syncCodebuddyCliLogs({ ...input, settleMs: 0 })).requestsWritten).toBe(1);
    expect((await syncCodebuddyCliLogs({ ...input, settleMs: 0 })).requestsWritten).toBe(0);
  });

  it("skips requests already collected from a transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(root, quaEndLine({ messageId: "msg_a" }));
    const eventLogPath = join(root, "events.jsonl");
    const transcriptLedgerPath = join(root, "workbuddy-ledger.json");
    await writeFile(
      transcriptLedgerPath,
      JSON.stringify({ eventIds: ["workbuddy:usage:msg_a"] })
    );

    const summary = await syncCodebuddyCliLogs({
      eventLogPath,
      cursorPath: join(root, "cursor.json"),
      ledgerPath: join(root, "ledger.json"),
      logRoot,
      workbuddyLedgerPath: transcriptLedgerPath,
      settleMs: 0
    });

    expect(summary.requestsSkippedAsDuplicate).toBe(1);
    expect(summary.requestsWritten).toBe(0);
    const events = await readEvents(eventLogPath);
    expect(events.some((event) => event.type === "token.usage.recorded")).toBe(false);
  });

  it("writes the request even before its credit is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(root, quaEndLine({ messageId: "msg_a" }));
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor.json");
    const ledgerPath = join(root, "ledger.json");

    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });

    const events = await readEvents(eventLogPath);
    const usage = events.filter((event) => event.type === "token.usage.recorded");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.credit).toBeUndefined();
  });

  it("re-emits a request once its credit arrives later", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(root, quaEndLine({ messageId: "msg_a" }));
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor.json");
    const ledgerPath = join(root, "ledger.json");

    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });
    const before = await readEvents(eventLogPath);
    expect(before.filter((event) => event.type === "token.usage.recorded")).toHaveLength(1);

    const dayDir = join(logRoot, "2026-10-27");
    await writeFile(
      join(dayDir, "d-projects-dev-demo__cc63707d9.log"),
      [quaEndLine({ messageId: "msg_a" }), creditLine(TURN_ID, "0.42")].join("\n") + "\n"
    );

    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });

    const usage = (await readEvents(eventLogPath)).filter(
      (event) => event.type === "token.usage.recorded"
    );
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({ credit: 0.42 });
    expect(usage[0]?.event_id).toBe(usage[1]?.event_id);
  });

  it("re-emits a request once an explicit zero cache read arrives later", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(
      root,
      quaEndLine({ messageId: "msg_a", promptTokens: 24733 })
    );
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor.json");
    const ledgerPath = join(root, "ledger.json");

    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });
    const before = (await readEvents(eventLogPath)).filter(
      (event) => event.type === "token.usage.recorded"
    );
    expect(before[0]).toMatchObject({ cache_read_input_tokens: 0 });
    expect(before[0]).not.toHaveProperty("cache_read_reported");

    const dayDir = join(logRoot, "2026-10-27");
    await writeFile(
      join(dayDir, "d-projects-dev-demo__cc63707d9.log"),
      [
        quaEndLine({ messageId: "msg_a", promptTokens: 24733 }),
        modelCallLine({ inputTokens: 24733, cachedReadTokens: 0 })
      ].join("\n") + "\n"
    );

    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });

    const usage = (await readEvents(eventLogPath)).filter(
      (event) => event.type === "token.usage.recorded"
    );
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({
      cache_read_input_tokens: 0,
      cache_read_reported: true
    });
    // The ledger key differs, the event identity does not: the projector fills
    // the stored row in place.
    expect(usage[1]?.event_id).toBe(usage[0]?.event_id);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { eventIds: string[] };
    const recordId = String(usage[0]?.source_record_id);
    expect(ledger.eventIds).toEqual(
      expect.arrayContaining([recordId, `${recordId}:cache-zero`])
    );

    // A further pass has nothing new to write.
    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });
    expect(
      (await readEvents(eventLogPath)).filter((event) => event.type === "token.usage.recorded")
    ).toHaveLength(2);
  });

  it("re-emits a request once its cache split arrives later", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(
      root,
      quaEndLine({ messageId: "msg_a", promptTokens: 24733 })
    );
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor.json");
    const ledgerPath = join(root, "ledger.json");

    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });
    const before = (await readEvents(eventLogPath)).filter(
      (event) => event.type === "token.usage.recorded"
    );
    expect(before).toHaveLength(1);
    expect(before[0]?.cache_read_input_tokens).toBe(0);

    const dayDir = join(logRoot, "2026-10-27");
    await writeFile(
      join(dayDir, "d-projects-dev-demo__cc63707d9.log"),
      [
        quaEndLine({ messageId: "msg_a", promptTokens: 24733 }),
        modelCallLine({ inputTokens: 24733, cachedReadTokens: 24000 })
      ].join("\n") + "\n"
    );

    await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });

    const usage = (await readEvents(eventLogPath)).filter(
      (event) => event.type === "token.usage.recorded"
    );
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({
      cache_read_input_tokens: 24000,
      input_tokens: 24733
    });
    expect(usage[0]?.event_id).toBe(usage[1]?.event_id);
  });

  it("leaves a half-written trailing line for the next pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-codebuddy-log-"));
    roots.push(root);
    const logRoot = await writeLog(
      root,
      quaEndLine({ messageId: "msg_a" }) + "\n" + '{"half":',
      { terminated: false }
    );
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "cursor.json");
    const ledgerPath = join(root, "ledger.json");

    const first = await syncCodebuddyCliLogs({ eventLogPath, cursorPath, ledgerPath, logRoot, settleMs: 0 });
    expect(first.requestsWritten).toBe(1);

    const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as {
      files: Record<string, { offset: number }>;
    };
    const offsets = Object.values(cursor.files);
    expect(offsets).toHaveLength(1);
    // The offset stops at the last newline so the fragment is re-read.
    expect(offsets[0]!.offset).toBeLessThan(
      Buffer.byteLength(quaEndLine({ messageId: "msg_a" }) + "\n" + '{"half":', "utf8")
    );
  });
});
