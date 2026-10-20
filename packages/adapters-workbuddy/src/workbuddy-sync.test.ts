import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

  beforeEach(async () => {
    isolated = await isolateSources();
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
  });

  it("syncs WorkBuddy transcripts into workbuddy events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-workbuddy-"));
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

  it("exposes the default and env-overridden source paths", () => {
    const root = join(tmpdir(), "agent-metrics-workbuddy-paths");
    process.env.AGENT_METRICS_WORKBUDDY_HOME = root;

    expect(resolveWorkbuddySourcePaths()).toEqual({
      homePath: root,
      projectsRoot: join(root, "projects")
    });
  });
});
