import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolateSources, type IsolatedSources } from "@agent-metrics/test-utils";
import { resolveDshSourcePaths, syncDshSessions } from "./dsh-sync.js";

describe("syncDshSessions", () => {
  let isolated: IsolatedSources | null = null;

  beforeEach(async () => {
    isolated = await isolateSources();
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
  });

  it("syncs JSONL session logs into dsh events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-dsh-"));
    const homePath = join(root, "dsh-home");
    const sessionDir = join(homePath, "sessions", "--demo--", "session-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 0,
          id: "session-1",
          createdAt: 1_786_587_424_043,
          cwd: "D:/projects/dev/demo",
          delegationDepth: 0
        }),
        JSON.stringify({
          type: "user/message",
          seq: 0,
          time: 1_786_587_424_415,
          data: {
            id: "msg_user_1",
            role: "user",
            content: [{ type: "text", text: "hello dsh" }],
            source: { kind: "user" }
          }
        }),
        JSON.stringify({
          type: "assistant/message",
          seq: 1,
          time: 1_786_587_704_487,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "msg_asst_1",
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              source: { kind: "model", provider: "deepseek", model: "deepseek-chat" }
            },
            usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0 }
          }
        })
      ].join("\n") + "\n"
    );

    process.env.AGENT_METRICS_DSH_HOME = homePath;
    const eventLogPath = join(root, "events.jsonl");
    await syncDshSessions({
      eventLogPath,
      cursorPath: join(root, "dsh-cursor.json"),
      ledgerPath: join(root, "dsh-ledger.json")
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; source_vendor: string; usage_source?: string });

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);
    expect(events.every((event) => event.source_vendor === "dsh")).toBe(true);
    expect(events[3]).toEqual(expect.objectContaining({ usage_source: "dsh-usage" }));

    await syncDshSessions({
      eventLogPath,
      cursorPath: join(root, "dsh-cursor.json"),
      ledgerPath: join(root, "dsh-ledger.json")
    });
    const rerun = (await readFile(eventLogPath, "utf8")).trim().split("\n");
    expect(rerun).toHaveLength(4);
  });

  it("syncs session.v3.jsonl logs when the legacy session.jsonl file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-dsh-v3-"));
    const homePath = join(root, "dsh-home");
    const sessionDir = join(homePath, "sessions", "--demo--", "session-v3");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.v3.jsonl"), buildSessionLog("session-v3", 10));

    process.env.AGENT_METRICS_DSH_HOME = homePath;
    const eventLogPath = join(root, "events.jsonl");
    await syncDshSessions({
      eventLogPath,
      cursorPath: join(root, "dsh-cursor.json"),
      ledgerPath: join(root, "dsh-ledger.json")
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; input_tokens?: number });

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);
    expect(events[3]).toEqual(expect.objectContaining({ type: "token.usage.recorded", input_tokens: 10 }));
  });

  it("prefers session.v3.jsonl over legacy session.jsonl in the same directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-dsh-prefer-v3-"));
    const homePath = join(root, "dsh-home");
    const sessionDir = join(homePath, "sessions", "--demo--", "session-both");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.jsonl"), buildSessionLog("session-both", 999));
    await writeFile(join(sessionDir, "session.v3.jsonl"), buildSessionLog("session-both", 10));

    process.env.AGENT_METRICS_DSH_HOME = homePath;
    const eventLogPath = join(root, "events.jsonl");
    await syncDshSessions({
      eventLogPath,
      cursorPath: join(root, "dsh-cursor.json"),
      ledgerPath: join(root, "dsh-ledger.json")
    });

    const usage = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; input_tokens?: number })
      .find((event) => event.type === "token.usage.recorded");

    expect(usage).toEqual(expect.objectContaining({ input_tokens: 10 }));
  });
});

function buildSessionLog(sessionId: string, inputTokens: number): string {
  return (
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        createdAt: 1_786_587_424_043,
        cwd: "D:/projects/dev/demo",
        delegationDepth: 0
      }),
      JSON.stringify({
        type: "user/message",
        seq: 0,
        time: 1_786_587_424_415,
        data: {
          id: "msg_user_1",
          role: "user",
          content: [{ type: "text", text: "hello dsh" }],
          source: { kind: "user" }
        }
      }),
      JSON.stringify({
        type: "assistant/message",
        seq: 1,
        time: 1_786_587_704_487,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "msg_asst_1",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            source: { kind: "model", provider: "deepseek", model: "deepseek-chat" }
          },
          usage: { inputTokens, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0 }
        }
      })
    ].join("\n") + "\n"
  );
}

describe("resolveDshSourcePaths", () => {
  let isolated: IsolatedSources | null = null;

  beforeEach(async () => {
    isolated = await isolateSources();
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
  });

  it("prefers AGENT_METRICS_DSH_HOME over the default home", () => {
    process.env.AGENT_METRICS_DSH_HOME = "D:/tmp/dsh-home";
    expect(resolveDshSourcePaths()).toEqual({
      homePath: "D:/tmp/dsh-home",
      sessionsRoot: join("D:/tmp/dsh-home", "sessions")
    });
  });
});
