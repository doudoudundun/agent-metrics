import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexRolloutParser,
  extractCodexEventsFromRollout
} from "./codex.js";
import { syncCodexRollouts } from "./codex-sync.js";

const sessionId = "019e5dc9-b10c-7371-8edd-066e8db7e50d";
const timestamp = "2026-10-08T16:00:00.000Z";
const rolloutFileName = `rollout-2026-10-08T16-00-00-${sessionId}.jsonl`;
const sessionModels: Record<string, string> = { [sessionId]: "gpt-5.4" };
const providerConfigs = {
  ai: { baseUrl: "https://api.psydo.top", host: "api.psydo.top" }
};

const record = (ts: string, type: string, payload: unknown): string =>
  JSON.stringify({ timestamp: ts, type, payload });

const rolloutLines = [
  record(timestamp, "session_meta", {
    id: sessionId,
    timestamp,
    cwd: "/fixture",
    model_provider: "ai"
  }),
  record("2026-10-08T16:00:01.000Z", "event_msg", { type: "user_message", message: "Review 中文 telemetry." }),
  record("2026-10-08T16:00:01.000Z", "event_msg", {
    type: "agent_message",
    message: "Reading the diff now.",
    phase: "commentary"
  }),
  record("2026-10-08T16:00:02.000Z", "response_item", {
    type: "custom_tool_call",
    call_id: "call_custom_1",
    name: "apply_patch",
    input: "*** Begin Patch\n*** End Patch\n"
  }),
  record("2026-10-08T16:00:03.000Z", "response_item", {
    type: "custom_tool_call_output",
    call_id: "call_custom_1",
    output: JSON.stringify({ output: "ok", metadata: { exit_code: 0, duration_seconds: 0.4 } })
  }),
  record("2026-10-08T16:00:04.000Z", "response_item", {
    type: "function_call",
    call_id: "call_shell_1",
    name: "shell_command",
    arguments: JSON.stringify({ command: "rg -n \"patch\" /fixture" })
  }),
  record("2026-10-08T16:00:05.000Z", "response_item", {
    type: "function_call_output",
    call_id: "call_shell_1",
    output: ["Exit code: 0", "Wall time: 2.3 seconds"].join("\n")
  }),
  record("2026-10-08T16:00:06.000Z", "event_msg", {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: 30321 },
      last_token_usage: {
        input_tokens: 15928,
        cached_input_tokens: 3456,
        output_tokens: 202,
        reasoning_output_tokens: 37,
        total_tokens: 16130
      }
    }
  }),
  record("2026-10-08T16:00:06.000Z", "event_msg", {
    type: "exec_command_end",
    call_id: "call_exec_1",
    command: ["bash", "-lc", "git diff"],
    exit_code: 0,
    duration: { secs: 1, nanos: 500_000_000 }
  }),
  record("2026-10-08T16:00:07.000Z", "event_msg", {
    type: "patch_apply_end",
    call_id: "call_patch_1",
    success: true,
    changes: {
      "src/app.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new\n" }
    }
  }),
  record("2026-10-08T16:00:08.000Z", "event_msg", { type: "web_search_end", call_id: "call_web_1" })
];

const expectedEvents = extractCodexEventsFromRollout({
  filePath: `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`,
  contents: rolloutLines.join("\n"),
  sessionModels,
  providerConfigs
});

describe("createCodexRolloutParser streaming equivalence", () => {
  const mirroredUsage = {
    input_tokens: 1000,
    cached_input_tokens: 400,
    output_tokens: 100,
    reasoning_output_tokens: 20,
    total_tokens: 1100
  };
  const mirrorLines = [
    rolloutLines[0],
    record("2026-10-08T16:00:01.000Z", "token_usage_record", {
      response_id: "response-one", usage: mirroredUsage
    }),
    record("2026-10-08T16:00:02.000Z", "event_msg", {
      type: "agent_message", message: "done", phase: "final"
    }),
    record("2026-10-08T16:00:03.000Z", "event_msg", {
      type: "user_message", message: "next"
    })
  ];

  it("retains mirror fallback and chronological order across every checkpoint split", () => {
    const options = { filePath: `/fixture/${rolloutFileName}`, sessionModels, providerConfigs };
    const expected = extractCodexEventsFromRollout({ ...options, contents: mirrorLines.join("\n") });
    expect(expected.map((event) => event.type)).toEqual([
      "session.started", "token.usage.recorded", "assistant.responded", "prompt.submitted"
    ]);
    expect(expected[1]).toMatchObject({ output_tokens: 100, decode_duration_ms: null });

    for (let split = 0; split <= mirrorLines.length; split += 1) {
      const first = createCodexRolloutParser(options);
      const collected = first.parseLines(mirrorLines.slice(0, split));
      const state = JSON.parse(JSON.stringify(first.checkpoint()));
      const second = createCodexRolloutParser(options, state);
      collected.push(...second.parseLines(mirrorLines.slice(split)), ...second.flush());
      expect(collected, `split after line ${split}`).toEqual(expected);
    }
  });

  it("discards earlier mirror chunks when a later chunk has authoritative usage", () => {
    const options = { filePath: `/fixture/${rolloutFileName}` };
    const first = createCodexRolloutParser(options);
    const collected = first.parseLines(mirrorLines);
    expect(collected.filter((event) => event.type === "token.usage.recorded")).toEqual([]);
    const second = createCodexRolloutParser(options, JSON.parse(JSON.stringify(first.checkpoint())));
    collected.push(...second.parseLines([
      record("2026-10-08T16:00:04.000Z", "event_msg", {
        type: "token_count", info: { last_token_usage: mirroredUsage }
      })
    ]), ...second.flush());
    expect(collected.filter((event) => event.type === "token.usage.recorded")).toEqual([
      expect.objectContaining({ source_record_id: `codex:session:${sessionId}:usage:1100` })
    ]);
  });

  it("remembers authoritative usage after flush and resume before a mirror append", () => {
    const options = { filePath: `/fixture/${rolloutFileName}` };
    const first = createCodexRolloutParser(options);
    const collected = first.parseLines([
      rolloutLines[0],
      record("2026-10-08T16:00:01.000Z", "event_msg", {
        type: "token_count", info: { last_token_usage: mirroredUsage }
      })
    ]);
    collected.push(...first.flush());
    const second = createCodexRolloutParser(options, JSON.parse(JSON.stringify(first.checkpoint())));
    collected.push(...second.parseLines(mirrorLines.slice(1)), ...second.flush());
    expect(collected.filter((event) => event.type === "token.usage.recorded")).toHaveLength(1);
  });

  it("matches whole-file extraction including same-timestamp reordering", () => {
    expect(expectedEvents.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "assistant.responded",
      "tool.called",
      "tool.succeeded",
      "tool.called",
      "tool.succeeded",
      // exec_command_end shares a timestamp with the preceding token_count
      // record; extraction orders it first, so chunked parsing must too.
      "tool.succeeded",
      "token.usage.recorded",
      "tool.succeeded",
      "code.edit.applied",
      "tool.succeeded"
    ]);
  });

  it("produces identical output for every chunk size", () => {
    for (const chunkSize of [1, 2, 3, 5]) {
      const parser = createCodexRolloutParser({
        filePath: `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`,
        sessionModels,
        providerConfigs
      });
      const collected = [];
      for (let index = 0; index < rolloutLines.length; index += chunkSize) {
        collected.push(...parser.parseLines(rolloutLines.slice(index, index + chunkSize)));
      }
      collected.push(...parser.flush());

      expect(collected, `chunk size ${chunkSize}`).toEqual(expectedEvents);
    }
  });

  it("produces identical output when checkpointing and resuming at every line boundary", () => {
    const filePath = `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`;
    for (let split = 0; split <= rolloutLines.length; split += 1) {
      const first = createCodexRolloutParser({ filePath, sessionModels, providerConfigs });
      const collected = [...first.parseLines(rolloutLines.slice(0, split))];
      const state = JSON.parse(JSON.stringify(first.checkpoint())) as ReturnType<
        typeof first.checkpoint
      >;
      const second = createCodexRolloutParser({ filePath, sessionModels, providerConfigs }, state);
      collected.push(...second.parseLines(rolloutLines.slice(split)));
      collected.push(...second.flush());

      expect(collected, `split after line ${split}`).toEqual(expectedEvents);
    }
  });

  it("restores turn model and tier from checkpoints and accepts legacy states without them", () => {
    const filePath = `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`;
    const options = { filePath, sessionModels, providerConfigs };
    const contextLines = [
      record(timestamp, "session_meta", { id: sessionId, timestamp, cwd: "/fixture" }),
      record("2026-10-08T16:00:00.500Z", "turn_context", {
        turn_id: "turn-1",
        model: "gpt-turn-1",
        service_tier: "priority"
      }),
      record("2026-10-08T16:00:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-1",
        started_at: Math.floor(Date.parse("2026-10-08T16:00:01.000Z") / 1000)
      })
    ];
    const tokenLine = record("2026-10-08T16:00:02.000Z", "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: 12 },
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 2,
          total_tokens: 12
        }
      }
    });

    const first = createCodexRolloutParser(options);
    first.parseLines(contextLines);
    const checkpoint = JSON.parse(JSON.stringify(first.checkpoint())) as ReturnType<
      typeof first.checkpoint
    >;
    const resumed = createCodexRolloutParser(options, checkpoint);
    const restoredUsage = [...resumed.parseLines([tokenLine]), ...resumed.flush()].find(
      (event) => event.type === "token.usage.recorded"
    );

    expect(restoredUsage).toMatchObject({
      type: "token.usage.recorded",
      model: "gpt-turn-1",
      service_tier: "priority"
    });

    const legacyCheckpoint = { ...checkpoint };
    delete legacyCheckpoint.turnId;
    delete legacyCheckpoint.turnModel;
    delete legacyCheckpoint.turnServiceTier;
    const legacyResume = createCodexRolloutParser(options, legacyCheckpoint);
    const legacyUsage = [...legacyResume.parseLines([tokenLine]), ...legacyResume.flush()].find(
      (event) => event.type === "token.usage.recorded"
    );

    expect(legacyUsage).toMatchObject({
      type: "token.usage.recorded",
      model: "gpt-5.4"
    });
    expect(legacyUsage?.service_tier).toBeUndefined();
  });

  it("restores persisted thread tier across checkpoints and resets on settings changes", () => {
    const filePath = `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`;
    const options = { filePath, sessionModels, providerConfigs };
    const first = createCodexRolloutParser(options);
    const collected = first.parseLines([
      record(timestamp, "session_meta", { id: sessionId, timestamp, cwd: "/fixture" }),
      record("2026-10-08T16:00:01.000Z", "event_msg", {
        type: "thread_settings_applied", thread_settings: { service_tier: "priority" }
      })
    ]);
    const resumed = createCodexRolloutParser(options, JSON.parse(JSON.stringify(first.checkpoint())));
    const tokenLine = (time: string, total: number) => record(time, "event_msg", {
      type: "token_count", info: {
        last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: total }
      }
    });
    collected.push(...resumed.parseLines([
      tokenLine("2026-10-08T16:00:02.000Z", 12),
      record("2026-10-08T16:00:03.000Z", "event_msg", {
        type: "thread_settings_applied", thread_settings: { service_tier: "default" }
      }),
      tokenLine("2026-10-08T16:00:04.000Z", 24)
    ]), ...resumed.flush());
    const usage = collected.filter((event) => event.type === "token.usage.recorded");
    expect(usage).toHaveLength(2);
    expect(usage[0].service_tier).toBe("priority");
    expect(usage[1].service_tier).toBeUndefined();
  });

  it("preserves output totals and decode timing across checkpoint resumes", () => {
    const filePath = `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`;
    const turnStart = "2026-10-08T16:00:00.000Z";
    const tokenCount = (ts: string, output: number, reasoning: number) => {
      const total = 1000 + output;
      return record(ts, "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
            total_tokens: total
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
            total_tokens: total
          }
        }
      });
    };
    const lines = [
      record(timestamp, "session_meta", { id: sessionId, timestamp, cwd: "/fixture" }),
      record(turnStart, "event_msg", {
        type: "task_started",
        started_at: Math.floor(Date.parse(turnStart) / 1000)
      }),
      // Codex's total is input + output; reasoning is already part of output.
      tokenCount("2026-10-08T16:00:04.000Z", 100, 20),
      tokenCount("2026-10-08T16:00:09.000Z", 250, 70)
    ];
    const options = { filePath, sessionModels, providerConfigs };
    const expected = extractCodexEventsFromRollout({ ...options, contents: lines.join("\n") });
    const expectedUsage = expected.filter((event) => event.type === "token.usage.recorded");

    expect(
      expectedUsage.map((event) => ({
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        first_token_latency_ms: event.first_token_latency_ms,
        decode_duration_ms: event.decode_duration_ms
      }))
    ).toEqual([
      {
        input_tokens: 1000,
        output_tokens: 100,
        first_token_latency_ms: 4000,
        decode_duration_ms: null
      },
      {
        input_tokens: 1000,
        output_tokens: 250,
        first_token_latency_ms: null,
        decode_duration_ms: 5000
      }
    ]);

    for (let split = 0; split <= lines.length; split += 1) {
      const first = createCodexRolloutParser(options);
      const collected = [...first.parseLines(lines.slice(0, split))];
      const state = JSON.parse(JSON.stringify(first.checkpoint())) as ReturnType<
        typeof first.checkpoint
      >;
      const resumed = createCodexRolloutParser(options, state);
      collected.push(...resumed.parseLines(lines.slice(split)), ...resumed.flush());

      expect(collected, `split after line ${split}`).toEqual(expected);
    }
  });

  it("keeps async custom and computer tool interruptions active across checkpoints", () => {
    const filePath = `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`;
    const options = { filePath, sessionModels, providerConfigs };
    const tokenCount = (ts: string, output: number) =>
      record(ts, "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1000 + output },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: output,
            total_tokens: 1000 + output
          }
        }
      });
    const taskStarted = record("2026-10-08T16:00:00.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-1",
      started_at: Math.floor(Date.parse("2026-10-08T16:00:00.000Z") / 1000)
    });
    const first = createCodexRolloutParser(options);
    const collected = [
      ...first.parseLines([
        meta,
        record("2026-10-08T16:00:00.500Z", "turn_context", {
          turn_id: "turn-1",
          model: "gpt-6.1-sol",
          service_tier: "priority"
        }),
        taskStarted,
        tokenCount("2026-10-08T16:00:04.000Z", 100),
        record("2026-10-08T16:00:05.000Z", "response_item", {
          type: "custom_tool_call",
          call_id: "custom-async-1",
          name: "delegate_task",
          input: {}
        }),
        record("2026-10-08T16:00:06.000Z", "response_item", {
          type: "computer_call",
          call_id: "computer-async-1",
          action: { type: "click" }
        })
      ])
    ];
    const checkpoint = JSON.parse(JSON.stringify(first.checkpoint())) as ReturnType<
      typeof first.checkpoint
    >;
    expect(checkpoint.activeTimingToolCalls).toEqual([
      "tool:custom-async-1",
      "tool:computer-async-1"
    ]);

    const second = createCodexRolloutParser(options, checkpoint);
    collected.push(
      ...second.parseLines([
        record("2026-10-08T16:00:08.000Z", "response_item", {
          type: "custom_tool_call_output",
          call_id: "custom-async-1",
          output: JSON.stringify({ output: "ok", metadata: { exit_code: 0 } })
        }),
        tokenCount("2026-10-08T16:00:09.000Z", 200),
        record("2026-10-08T16:00:11.000Z", "response_item", {
          type: "computer_call_output",
          call_id: "computer-async-1",
          output: { type: "computer_screenshot" }
        }),
        tokenCount("2026-10-08T16:00:12.000Z", 300),
        tokenCount("2026-10-08T16:00:19.000Z", 400)
      ]),
      ...second.flush()
    );

    const usageEvents = collected.filter((event) => event.type === "token.usage.recorded");
    expect(usageEvents.map((event) => event.output_tokens)).toEqual([100, 200, 300, 400]);
    expect(usageEvents.map((event) => event.message_id)).toEqual([
      "usage_1100",
      "usage_1200",
      "usage_1300",
      "usage_1400"
    ]);
    expect(usageEvents.map((event) => event.decode_duration_ms)).toEqual([
      null,
      null,
      null,
      7000
    ]);
    expect(usageEvents.map((event) => event.first_token_latency_ms)).toEqual([
      4000,
      null,
      null,
      null
    ]);
  });

  it("reconstructs active timing tools from a legacy checkpoint", () => {
    const filePath = `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`;
    const options = { filePath, sessionModels, providerConfigs };
    const tokenCount = (ts: string, output: number) =>
      record(ts, "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1000 + output },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 0,
            output_tokens: output,
            total_tokens: 1000 + output
          }
        }
      });
    const first = createCodexRolloutParser(options);
    first.parseLines([
      meta,
      record("2026-10-08T16:00:00.500Z", "event_msg", {
        type: "task_started",
        started_at: Math.floor(Date.parse("2026-10-08T16:00:00.000Z") / 1000)
      }),
      tokenCount("2026-10-08T16:00:04.000Z", 100),
      record("2026-10-08T16:00:05.000Z", "response_item", {
        type: "function_call",
        call_id: "legacy-call-1",
        name: "exec_command",
        arguments: "{}"
      })
    ]);
    const legacyCheckpoint = JSON.parse(JSON.stringify(first.checkpoint())) as ReturnType<
      typeof first.checkpoint
    >;
    delete legacyCheckpoint.activeTimingToolCalls;
    delete legacyCheckpoint.activeUnkeyedTimingTools;
    delete legacyCheckpoint.lastTokenEventModel;
    delete legacyCheckpoint.lastTokenEventTier;

    const resumed = createCodexRolloutParser(options, legacyCheckpoint);
    const events = [
      ...resumed.parseLines([
        record("2026-10-08T16:00:08.000Z", "response_item", {
          type: "function_call_output",
          call_id: "legacy-call-1",
          output: "Exit code: 0\nWall time: 3 seconds"
        }),
        tokenCount("2026-10-08T16:00:09.000Z", 200),
        tokenCount("2026-10-08T16:00:16.000Z", 300)
      ]),
      ...resumed.flush()
    ];

    const usageEvents = events.filter((event) => event.type === "token.usage.recorded");
    expect(usageEvents.map((event) => event.decode_duration_ms)).toEqual([null, 7000]);
    expect(usageEvents.map((event) => event.output_tokens)).toEqual([200, 300]);
  });

  it("keeps pending tool calls in a checkpoint so appended outputs still pair up", () => {
    const filePath = `/home/fixture/.codex/sessions/2026/10/08/${rolloutFileName}`;
    const call = record("2026-10-08T16:00:02.000Z", "response_item", {
      type: "function_call",
      call_id: "call_split_1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "echo 中文" })
    });
    const output = record("2026-10-08T16:00:03.000Z", "response_item", {
      type: "function_call_output",
      call_id: "call_split_1",
      output: "Exit code: 0\nWall time: 1 seconds"
    });

    const first = createCodexRolloutParser({ filePath, sessionModels, providerConfigs });
    // The lone record stays buffered until a newer timestamp or flush(); its
    // context must therefore travel through the checkpoint itself.
    expect(first.parseLines([call])).toEqual([]);

    const state = JSON.parse(JSON.stringify(first.checkpoint())) as ReturnType<
      typeof first.checkpoint
    >;
    expect(state.pendingToolCalls).toHaveLength(1);
    expect(state.pendingEvents.map((event) => event.type)).toEqual(["tool.called"]);

    const second = createCodexRolloutParser({ filePath, sessionModels, providerConfigs }, state);
    const resumed = [...second.parseLines([output]), ...second.flush()];
    expect(resumed.map((event) => event.type)).toEqual(["tool.called", "tool.succeeded"]);
    expect(resumed[1]).toMatchObject({ tool_name: "echo", duration_ms: 1000 });
  });
});

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const meta = { timestamp, type: "session_meta", payload: { id: sessionId, timestamp, cwd: "/fixture" } };
const line = (payload: unknown): string => `${JSON.stringify(payload)}\n`;

async function createSyncFixture(): Promise<{
  rolloutPath: string;
  sessionsRoot: string;
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  logsDbPath: string;
  configPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-streaming-"));
  tempRoots.push(root);
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot);
  return {
    rolloutPath: join(sessionsRoot, rolloutFileName),
    sessionsRoot,
    eventLogPath: join(root, "events.jsonl"),
    cursorPath: join(root, "cursor.json"),
    ledgerPath: join(root, "ledger.json"),
    logsDbPath: join(root, "absent.sqlite"),
    configPath: join(root, "absent.toml")
  };
}

async function readEvents(path: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter((value) => value.length > 0)
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

type CursorEntry = { offset: number; caughtUp: boolean; ino: number };

async function readCursorEntry(cursorPath: string, rolloutPath: string): Promise<CursorEntry> {
  const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as {
    rolloutFiles: Record<string, CursorEntry>;
  };
  return cursor.rolloutFiles[rolloutPath];
}

describe("bounded streaming codex sync", () => {
  it("dedupes a mirror published at EOF against its later token_count append", async () => {
    const input = await createSyncFixture();
    const usage = {
      input_tokens: 1000, cached_input_tokens: 400,
      output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1100
    };
    await writeFile(input.rolloutPath, line(meta) + line({
      timestamp, type: "token_usage_record",
      payload: { response_id: "response-one", usage, thread_token_usage: usage }
    }));
    await syncCodexRollouts(input);
    let events = await readEvents(input.eventLogPath);
    expect(events.filter((event) => event.type === "token.usage.recorded")).toEqual([
      expect.objectContaining({
        source_record_id: `codex:session:${sessionId}:usage:1100`,
        message_id: "usage_1100", output_tokens: 100, decode_duration_ms: null
      })
    ]);

    await appendFile(input.rolloutPath, line({
      timestamp: "2026-10-08T16:00:00.003Z", type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } }
    }));
    await syncCodexRollouts(input);
    events = await readEvents(input.eventLogPath);
    expect(events.filter((event) => event.type === "token.usage.recorded")).toHaveLength(1);

    // A later distinct response still contributes its own usage.
    await appendFile(input.rolloutPath, line({
      timestamp: "2026-10-08T16:00:02.000Z", type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage, total_token_usage: { ...usage, total_tokens: 2200 } }
      }
    }));
    await syncCodexRollouts(input);
    events = await readEvents(input.eventLogPath);
    expect(events.filter((event) => event.type === "token.usage.recorded")).toHaveLength(2);
  });

  it("waits until EOF before choosing mirror fallback across byte-budgeted syncs", async () => {
    const input = await createSyncFixture();
    const usage = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 };
    await writeFile(input.rolloutPath, [
      meta,
      { timestamp, type: "token_usage_record", payload: { response_id: "response-one", usage } },
      { timestamp, type: "event_msg", payload: { type: "user_message", message: "later" } },
      { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage } } }
    ].map(line).join(""));
    let caughtUp = false;
    for (let run = 0; run < 10 && !caughtUp; run += 1) {
      await syncCodexRollouts({ ...input, maxBytesPerFile: 1, maxBytesPerSync: 1 });
      caughtUp = (await readCursorEntry(input.cursorPath, input.rolloutPath)).caughtUp;
    }
    expect(caughtUp).toBe(true);
    const events = await readEvents(input.eventLogPath);
    expect(events.filter((event) => event.type === "token.usage.recorded")).toEqual([
      expect.objectContaining({ source_record_id: `codex:session:${sessionId}:usage:1100` })
    ]);
  });

  it("imports a 27 MiB image tool result across bounded runs without duplicates", async () => {
    const input = await createSyncFixture();
    const call = {
      timestamp,
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "image-one",
        name: "image_tool",
        input: "fixture"
      }
    };
    const output = {
      timestamp,
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "image-one",
        output: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${"a".repeat(27 * 1024 * 1024)}`
          }
        ]
      }
    };
    const prompt = {
      timestamp,
      type: "event_msg",
      payload: { type: "user_message", message: "after image" }
    };
    await writeFile(input.rolloutPath, line(meta) + line(call) + line(output) + line(prompt));

    await syncCodexRollouts(input);
    // The per-file budget stops after the oversized record: complete records
    // are never split, and the file is not caught up yet.
    const afterFirst = await readCursorEntry(input.cursorPath, input.rolloutPath);
    expect(afterFirst.caughtUp).toBe(false);
    expect(afterFirst.offset).toBe(Buffer.byteLength(line(meta) + line(call) + line(output)));

    await syncCodexRollouts(input);
    const afterSecond = await readCursorEntry(input.cursorPath, input.rolloutPath);
    expect(afterSecond.caughtUp).toBe(true);
    expect(afterSecond.offset).toBe((await stat(input.rolloutPath)).size);

    const events = await readEvents(input.eventLogPath);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
      // The image part carries image_url, not text; coerced output is empty,
      // which the terminal-state policy records as a failed tool run.
      "tool.failed"
    ]);
    expect(new Set(events.map((event) => event.source_record_id)).size).toBe(events.length);

    // A fully caught-up, unchanged file is not re-read: the cursor (and log)
    // stay byte-identical on the next run.
    const cursorBefore = await readFile(input.cursorPath, "utf8");
    const logBefore = await readFile(input.eventLogPath, "utf8");
    await syncCodexRollouts(input);
    expect(await readFile(input.cursorPath, "utf8")).toBe(cursorBefore);
    expect(await readFile(input.eventLogPath, "utf8")).toBe(logBefore);
  });

  it("persists pending tool context across syncs and completes the pair after append", async () => {
    const input = await createSyncFixture();
    await writeFile(
      input.rolloutPath,
      line(meta) +
        line({
          timestamp,
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "tool-one",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "echo 中文" })
          }
        })
    );
    await syncCodexRollouts(input);

    const appended = line({
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "tool-one",
        output: "Exit code: 0\nWall time: 1 seconds"
      }
    });
    await appendFile(input.rolloutPath, appended.slice(0, -5));
    await syncCodexRollouts(input);
    await appendFile(input.rolloutPath, appended.slice(-5));
    await syncCodexRollouts(input);

    const events = await readEvents(input.eventLogPath);
    expect(events.filter((event) => event.type === "tool.succeeded")).toEqual([
      expect.objectContaining({ session_id: sessionId, tool_name: "echo", duration_ms: 1000 })
    ]);

    await syncCodexRollouts(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(3);
  });

  it("replays a partial multibyte tail exactly once after the record completes", async () => {
    const input = await createSyncFixture();
    await writeFile(input.rolloutPath, line(meta));
    await syncCodexRollouts(input);

    const prompt = line({
      timestamp,
      type: "event_msg",
      payload: { type: "user_message", message: "新增读数" }
    });
    await appendFile(input.rolloutPath, prompt.slice(0, -6));
    await syncCodexRollouts(input);
    // The truncated record must not commit anything yet.
    expect((await readEvents(input.eventLogPath)).map((event) => event.type)).toEqual([
      "session.started"
    ]);
    // Its bytes are not checkpointed: the offset waits at the record start.
    const partial = await readCursorEntry(input.cursorPath, input.rolloutPath);
    expect(partial.caughtUp).toBe(true);
    expect(partial.offset).toBe(Buffer.byteLength(line(meta)));

    await appendFile(input.rolloutPath, prompt.slice(-6));
    await syncCodexRollouts(input);

    const events = await readEvents(input.eventLogPath);
    expect(events.map((event) => event.type)).toEqual(["session.started", "prompt.submitted"]);
    expect(new Set(events.map((event) => event.source_record_id)).size).toBe(events.length);
    expect(await readCursorEntry(input.cursorPath, input.rolloutPath)).toMatchObject({
      caughtUp: true,
      offset: (await stat(input.rolloutPath)).size
    });

    const logBefore = await readFile(input.eventLogPath, "utf8");
    await syncCodexRollouts(input);
    expect(await readFile(input.eventLogPath, "utf8")).toBe(logBefore);
  });

  it("checkpoints bounded batches and catches up across runs without losing events", async () => {
    const input = await createSyncFixture();
    const promptLines = Array.from({ length: 12 }, (_, index) =>
      line({
        timestamp: `2026-10-08T16:00:${String(index + 10).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "user_message", message: "fixture" }
      })
    );
    // CRLF endings exercise byte offsets against \r\n records.
    await writeFile(
      input.rolloutPath,
      (line(meta) + promptLines.join("")).replaceAll("\n", "\r\n")
    );

    let caughtUp = false;
    for (let run = 0; run < 30 && !caughtUp; run += 1) {
      await syncCodexRollouts({ ...input, maxBytesPerFile: 100, maxBytesPerSync: 100 });
      caughtUp = (await readCursorEntry(input.cursorPath, input.rolloutPath)).caughtUp;
    }
    expect(caughtUp).toBe(true);

    const events = await readEvents(input.eventLogPath);
    expect(events).toHaveLength(13);
    expect(new Set(events.map((event) => event.source_record_id)).size).toBe(13);
  });

  it("syncs newer rollouts first and isolates oversized records from the run", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const input = await createSyncFixture();
    const oldSessionsRoot = join(join(input.sessionsRoot, ".."), "old-sessions");
    await mkdir(oldSessionsRoot);
    const activeSessionId = "019f7d68-67d0-74d2-bbfc-67adbe750b4e";
    const activePath = join(
      input.sessionsRoot,
      `rollout-2026-10-08T17-00-00-${activeSessionId}.jsonl`
    );
    const oversizedPath = join(
      oldSessionsRoot,
      `rollout-2026-10-08T16-00-00-${sessionId}.jsonl`
    );
    await writeFile(
      activePath,
      line({
        timestamp,
        type: "session_meta",
        payload: { id: activeSessionId, timestamp, cwd: "/fixture" }
      })
    );
    await writeFile(
      oversizedPath,
      line({
        timestamp,
        type: "event_msg",
        payload: { type: "user_message", message: "a".repeat(65 * 1024 * 1024) }
      })
    );
    const stale = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await utimes(oversizedPath, stale, stale);

    await syncCodexRollouts({
      ...input,
      sessionsRoots: [input.sessionsRoot, oldSessionsRoot]
    });

    const events = await readEvents(input.eventLogPath);
    expect(events).toEqual([
      expect.objectContaining({ session_id: activeSessionId, type: "session.started" })
    ]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(oversizedPath));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("JSONL record exceeds"));

    // The oversized file stays untouched and retryable; the run still succeeds.
    await syncCodexRollouts({
      ...input,
      sessionsRoots: [input.sessionsRoot, oldSessionsRoot]
    });
    expect(await readEvents(input.eventLogPath)).toHaveLength(1);
  }, 30_000);

  it("rebuilds turn context when an active legacy checkpoint has no turn metadata", async () => {
    const input = await createSyncFixture();
    const tokenCount = (ts: string, total: number, output: number) =>
      line({
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: total },
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: output,
              total_tokens: 10 + output
            }
          }
        }
      });
    await writeFile(
      input.rolloutPath,
      line(meta) +
        line({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }) +
        line({ timestamp, type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-turn-1" } }) +
        tokenCount("2026-10-08T16:00:02.000Z", 100, 10)
    );
    await syncCodexRollouts(input);

    const cursor = JSON.parse(await readFile(input.cursorPath, "utf8")) as {
      rolloutFiles: Record<string, { parserState?: Record<string, unknown> }>;
      sessionModels: Record<string, string>;
    };
    const parserState = cursor.rolloutFiles[input.rolloutPath].parserState;
    expect(parserState?.turnModel).toBe("gpt-turn-1");
    delete parserState?.turnId;
    delete parserState?.turnModel;
    delete parserState?.turnServiceTier;
    cursor.sessionModels[sessionId] = "gpt-session-latest";
    await writeFile(input.cursorPath, JSON.stringify(cursor), "utf8");

    await appendFile(input.rolloutPath, tokenCount("2026-10-08T16:00:03.000Z", 200, 20));
    await syncCodexRollouts(input);

    const appendedUsage = (await readEvents(input.eventLogPath)).find(
      (event) => event.source_record_id === `codex:session:${sessionId}:usage:200`
    );
    expect(appendedUsage).toMatchObject({ type: "token.usage.recorded", model: "gpt-turn-1" });
  });

  it("rebuilds thread tier when an older active checkpoint did not save it", async () => {
    const input = await createSyncFixture();
    await writeFile(input.rolloutPath, line(meta) + line({
      timestamp, type: "event_msg", payload: {
        type: "thread_settings_applied", thread_settings: { service_tier: "priority" }
      }
    }));
    await syncCodexRollouts(input);
    const cursor = JSON.parse(await readFile(input.cursorPath, "utf8")) as {
      rolloutFiles: Record<string, { parserState: Record<string, unknown> }>;
    };
    const parserState = cursor.rolloutFiles[input.rolloutPath].parserState;
    expect(parserState.threadServiceTier).toBe("priority");
    delete parserState.threadServiceTier;
    await writeFile(input.cursorPath, JSON.stringify(cursor), "utf8");
    await appendFile(input.rolloutPath, line({
      timestamp: "2026-10-08T16:00:02.000Z", type: "event_msg", payload: {
        type: "token_count", info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, total_tokens: 12 }
        }
      }
    }));
    await syncCodexRollouts(input);
    const usage = (await readEvents(input.eventLogPath)).find((event) => event.type === "token.usage.recorded");
    expect(usage).toMatchObject({ service_tier: "priority" });
    expect((await readEvents(input.eventLogPath)).filter((event) => event.type === "session.started")).toHaveLength(1);
  });

  it("treats legacy cursor entries without checkpoints as not caught up and re-reads them", async () => {
    const input = await createSyncFixture();
    const prompt = {
      timestamp,
      type: "event_msg",
      payload: { type: "user_message", message: "legacy cursor" }
    };
    await writeFile(input.rolloutPath, line(meta) + line(prompt));
    await syncCodexRollouts(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(2);

    const details = await stat(input.rolloutPath);
    await writeFile(
      input.cursorPath,
      JSON.stringify({
        rolloutFiles: {
          [input.rolloutPath]: { size: details.size, mtimeMs: details.mtimeMs }
        },
        logsLastId: 0,
        sessionModels: {}
      })
    );

    await syncCodexRollouts(input);

    // The whole file was re-parsed, but ledger keys deduplicated every event.
    const events = await readEvents(input.eventLogPath);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.source_record_id)).size).toBe(2);

    const entry = await readCursorEntry(input.cursorPath, input.rolloutPath);
    expect(entry.caughtUp).toBe(true);
    expect(entry.offset).toBe(details.size);
  });
});
