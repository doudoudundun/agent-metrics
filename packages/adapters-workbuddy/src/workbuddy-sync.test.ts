import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolateSources, type IsolatedSources } from "@agent-metrics/test-utils";
import { resolveWorkbuddySourcePaths, syncWorkbuddySessions } from "./workbuddy-sync.js";

const SESSION_ID = "2bb20abd-dfb2-439c-b3bc-b150e6eef336";

function buildRecords(): string[] {
  return [
    {
      type: "session-meta",
      id: "meta_1",
      sessionId: SESSION_ID,
      timestamp: 1_792_463_851_438,
      meta: { "codebuddy.ai/hostKind": "unopted" }
    },
    {
      id: "msg_user_1",
      timestamp: 1_792_463_849_462,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "把 workbuddy 的信息源加上" }],
      providerData: { startsNewUserRequest: true, agent: "cli" },
      sessionId: SESSION_ID,
      cwd: "D:/projects/dev/demo"
    },
    {
      id: "rec_call_1",
      timestamp: 1_792_463_858_468,
      type: "function_call",
      callId: "call_1",
      name: "Bash",
      arguments: "{\"command\":\"ls\"}",
      sessionId: SESSION_ID,
      cwd: "D:/projects/dev/demo",
      providerData: {
        conversationRequestId: "req_1",
        messageId: "asst_msg_1",
        stepSeq: 1,
        model: "deepseek-v4.1-flash"
      }
    },
    {
      id: "rec_result_1",
      timestamp: 1_792_463_860_647,
      type: "function_call_result",
      name: "Bash",
      callId: "call_1",
      status: "completed",
      output: { type: "text", text: "ok" },
      sessionId: SESSION_ID,
      cwd: "D:/projects/dev/demo"
    },
    {
      id: "asst_msg_1",
      timestamp: 1_792_463_891_326,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
      sessionId: SESSION_ID,
      cwd: "D:/projects/dev/demo",
      providerData: {
        conversationRequestId: "req_1",
        messageId: "asst_msg_1",
        stepSeq: 1,
        model: "deepseek-v4.1-flash",
        usage: {
          requests: 1,
          inputTokens: 1000,
          outputTokens: 50,
          totalTokens: 1050,
          inputTokensDetails: [{ cached_tokens: 800 }]
        },
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_cache_hit_tokens: 800,
          prompt_cache_write_tokens: 0
        }
      }
    }
  ].map((record) => JSON.stringify(record));
}

describe("syncWorkbuddySessions", () => {
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

  it("syncs WorkBuddy transcripts into workbuddy events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-workbuddy-"));
    roots.push(root);
    const homePath = join(root, "workbuddy-home");
    const projectDir = join(homePath, "projects", "d-projects-dev-demo");
    await mkdir(projectDir, { recursive: true });
    const logPath = join(projectDir, `${SESSION_ID}.jsonl`);
    await writeFile(logPath, buildRecords().join("\n") + "\n");

    process.env.AGENT_METRICS_WORKBUDDY_HOME = homePath;
    const eventLogPath = join(root, "events.jsonl");
    const cursorPath = join(root, "workbuddy-cursor.json");
    const ledgerPath = join(root, "workbuddy-ledger.json");

    await syncWorkbuddySessions({ eventLogPath, cursorPath, ledgerPath });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            source_vendor: string;
            usage_source?: string;
            input_tokens?: number;
            cache_read_input_tokens?: number;
          }
      );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.called",
      "tool.succeeded",
      "assistant.responded",
      "token.usage.recorded"
    ]);
    expect(events.every((event) => event.source_vendor === "workbuddy")).toBe(true);
    expect(events[5]).toEqual(
      expect.objectContaining({
        usage_source: "workbuddy-usage",
        input_tokens: 1000,
        cache_read_input_tokens: 800
      })
    );

    // Re-running against an unchanged file must not duplicate events.
    await syncWorkbuddySessions({ eventLogPath, cursorPath, ledgerPath });
    expect((await readFile(eventLogPath, "utf8")).trim().split("\n")).toHaveLength(6);

    // Appending a new tool turn emits only the new events.
    await writeFile(
      logPath,
      buildRecords()
        .concat(
          JSON.stringify({
            id: "rec_call_2",
            timestamp: 1_792_463_900_000,
            type: "function_call",
            callId: "call_2",
            name: "Read",
            arguments: "{\"file_path\":\"README.md\"}",
            sessionId: SESSION_ID,
            cwd: "D:/projects/dev/demo"
          })
        )
        .join("\n") + "\n"
    );
    await syncWorkbuddySessions({ eventLogPath, cursorPath, ledgerPath });

    const appended = (await readFile(eventLogPath, "utf8")).trim().split("\n");
    expect(appended).toHaveLength(7);
    const lastEvent = JSON.parse(appended[6]) as { type: string };
    expect(lastEvent.type).toBe("tool.called");
  });

  it("discovers agent-team sub-agent transcripts under <session>/subagents", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-workbuddy-team-"));
    roots.push(root);
    const homePath = join(root, "workbuddy-home");
    const projectDir = join(homePath, "projects", "d-projects-dev-demo");
    const sessionDir = join(projectDir, SESSION_ID);
    const subagentsDir = join(sessionDir, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(join(projectDir, `${SESSION_ID}.jsonl`), buildRecords().join("\n") + "\n");

    const subSessionId = "01a15c54-b8f0-7965-a912-12b2c52a7baf";
    const subRecords = buildRecords().map((text) => JSON.parse(text));
    for (const record of subRecords) {
      record.sessionId = subSessionId;
    }
    subRecords[4].providerData.traceId = "trace-sub";
    await writeFile(
      join(subagentsDir, "agent-2ff04857-5c89-487f-9512-5c22cff87ccf.jsonl"),
      subRecords.map((record) => JSON.stringify(record)).join("\n") + "\n"
    );
    await mkdir(join(subagentsDir, "agent-2ff04857-5c89-487f-9512-5c22cff87ccf"), { recursive: true });

    const input = {
      homePath,
      eventLogPath: join(root, "events.jsonl"),
      cursorPath: join(root, "cursor.json"),
      ledgerPath: join(root, "ledger.json")
    };
    await syncWorkbuddySessions(input);

    const events = (await readFile(input.eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; session_id: string; input_tokens?: number });
    const subUsage = events.filter(
      (event) => event.type === "token.usage.recorded" && event.session_id === subSessionId
    );
    expect(subUsage).toHaveLength(1);
    expect(subUsage[0]).toEqual(expect.objectContaining({ input_tokens: 1000 }));
    expect(events.filter((event) => event.type === "session.started").map((event) => event.session_id)).toEqual([
      SESSION_ID,
      subSessionId
    ]);

    // Re-running against unchanged files must not duplicate events.
    await syncWorkbuddySessions(input);
    expect((await readFile(input.eventLogPath, "utf8")).trim().split("\n")).toHaveLength(events.length);
  });

  it("enriches existing usage when model logs arrive after the transcript, exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-workbuddy-late-")); roots.push(root);
    const homePath = join(root, "home");
    const project = join(homePath, "projects", "demo"); await mkdir(project, { recursive: true });
    const records = buildRecords().map((text) => JSON.parse(text));
    records[4].providerData.traceId = "trace-1";
    await writeFile(join(project, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const input = { homePath, eventLogPath: join(root, "events.jsonl"),
      cursorPath: join(root, "cursor.json"), ledgerPath: join(root, "ledger.json") };
    const events = async () => (await readFile(input.eventLogPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    await syncWorkbuddySessions(input);
    const original = (await events()).find((e) => e.type === "token.usage.recorded");
    expect(original.decode_duration_ms).toBeNull();
    const dir = join(homePath, "logs", "2026-10-20"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.log"),
      '[2026/10/20 10:38:11.326] [Info] [pid=1] [ModelProvider]  [SseMonitor#req] qua.end: ' + JSON.stringify({
        conversation_id: SESSION_ID, conversation_request_id: "req_1", message_id: "asst_msg_1",
        trace_id: "trace-1", model: "deepseek-v4.1-flash", request_type: "chat", report_source: "agent-cli",
        finish_flag: "done", http_begin_status_code: "200", http_end_status_code: "200",
        model_error: "", model_error_code: "", total_cost_ms: "1500", ttft_ms: "500",
        prompt_tokens: "1000", completion_tokens: "50", total_tokens: "1050"
      }) + "\n");
    await syncWorkbuddySessions(input);
    const enriched = await events();
    expect(enriched).toHaveLength(7);
    expect(enriched[6]).toMatchObject({ event_id: original.event_id, first_token_latency_ms: 500, decode_duration_ms: 1000 });
    await syncWorkbuddySessions(input);
    expect(await events()).toHaveLength(7);
  });

  it("exposes the default and env-overridden source paths", () => {
    const root = join(tmpdir(), "agent-metrics-workbuddy-paths");
    process.env.AGENT_METRICS_WORKBUDDY_HOME = root;

    expect(resolveWorkbuddySourcePaths()).toEqual({
      homePath: root,
      projectsRoot: join(root, "projects")
    });
  });
});
