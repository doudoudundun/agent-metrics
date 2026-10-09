import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolateSources, type IsolatedSources } from "@agent-metrics/test-utils";
import { resolveKimicodeSourcePaths, syncKimicodeSessions } from "./kimicode-sync.js";

describe("syncKimicodeSessions", () => {
  let isolated: IsolatedSources | null = null;
  let root: string;

  beforeEach(async () => {
    isolated = await isolateSources();
    root = await mkdtemp(join(tmpdir(), "agent-metrics-kimicode-"));
  });

  afterEach(async () => {
    isolated?.cleanup();
    isolated = null;
    await rm(root, { recursive: true, force: true });
  });

  it("syncs session_index and wire usage into kimicode events", async () => {
    const homePath = join(root, "kimi-code");
    const sessionDir = join(homePath, "sessions", "wd_demo", "session_1");
    const agentDir = join(sessionDir, "agents", "main");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(homePath, "session_index.jsonl"),
      `${JSON.stringify({
        sessionId: "session_1",
        sessionDir,
        workDir: "D:/projects/dev/demo"
      })}\n`
    );
    await writeFile(
      join(sessionDir, "state.json"),
      JSON.stringify({
        id: "session_1",
        cwd: "D:/projects/dev/demo",
        createdAt: 1_786_587_424_043,
        archived: false,
        agents: { main: { homedir: agentDir, type: "main" } }
      })
    );
    await writeFile(
      join(agentDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "turn.prompt",
          input: [{ type: "text", text: "hello kimi" }],
          time: 1_786_587_424_415
        }),
        JSON.stringify({
          type: "usage.record",
          model: "kimi-code/k3-256k",
          usage: { inputOther: 10, output: 4, inputCacheRead: 2, inputCacheCreation: 0 },
          usageScope: "turn",
          time: 1_786_587_704_487
        })
      ].join("\n") + "\n"
    );

    process.env.AGENT_METRICS_KIMICODE_HOME = homePath;
    const eventLogPath = join(root, "events.jsonl");
    await syncKimicodeSessions({
      eventLogPath,
      cursorPath: join(root, "kimicode-cursor.json"),
      ledgerPath: join(root, "kimicode-ledger.json")
    });

    const events = (await readFile(eventLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; source_vendor: string; usage_source?: string });

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "token.usage.recorded"
    ]);
    expect(events.every((event) => event.source_vendor === "kimicode")).toBe(true);
    expect(events[2]).toEqual(expect.objectContaining({ usage_source: "kimicode-usage" }));

    await syncKimicodeSessions({
      eventLogPath,
      cursorPath: join(root, "kimicode-cursor.json"),
      ledgerPath: join(root, "kimicode-ledger.json")
    });
    const rerun = (await readFile(eventLogPath, "utf8")).trim().split("\n");
    expect(rerun).toHaveLength(3);
  });

  it("keeps partial JSON and UTF-8 bytes until an appended record is complete", async () => {
    const { wirePath, input } = await createWireFixture(root);
    const record = Buffer.from(JSON.stringify({
      type: "turn.prompt", input: [{ type: "text", text: "中文" }], time: 1_786_587_424_415
    }) + "\n");
    const split = record.indexOf(Buffer.from("中")) + 1;
    await writeFile(wirePath, record.subarray(0, split));
    await syncKimicodeSessions(input);
    const cursor = JSON.parse(await readFile(input.cursorPath, "utf8"));
    expect(cursor.wires[wirePath].offset).toBe(split - 1);

    await appendFile(wirePath, record.subarray(split));
    await syncKimicodeSessions(input);
    let events = (await readFile(input.eventLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "prompt.submitted", prompt_chars: 2 });

    await syncKimicodeSessions(input);
    events = (await readFile(input.eventLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);

    // A shortened/replaced wire starts again at byte zero; the ledger still
    // prevents duplicates from old records if they reappear after truncation.
    await writeFile(wirePath, JSON.stringify({
      type: "turn.prompt", input: [{ type: "text", text: "new" }], time: 1_786_587_424_416
    }) + "\n");
    await syncKimicodeSessions(input);
    events = (await readFile(input.eventLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "prompt.submitted", prompt_chars: 3 });
  });

  it("decodes a UTF-8 character crossing the bounded read chunk", async () => {
    const { wirePath, input } = await createWireFixture(root);
    const prefix = '{"type":"turn.prompt","input":[{"type":"text","text":"';
    const text = "x".repeat(256 * 1024 - Buffer.byteLength(prefix) - 1) + "中文";
    await writeFile(wirePath, JSON.stringify({
      type: "turn.prompt", input: [{ type: "text", text }], time: 1_786_587_424_415
    }) + "\n");
    await syncKimicodeSessions(input);
    const events = (await readFile(input.eventLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "prompt.submitted", prompt_chars: text.length });
  });
});

async function createWireFixture(root: string) {
  const homePath = join(root, "kimi-code");
  const sessionDir = join(homePath, "sessions", "test-session");
  const agentDir = join(sessionDir, "agents", "main");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(homePath, "session_index.jsonl"), JSON.stringify({
    sessionId: "test-session", sessionDir, workDir: "D:/test"
  }) + "\n");
  return {
    wirePath: join(agentDir, "wire.jsonl"),
    input: {
      homePath,
      eventLogPath: join(root, "events.jsonl"),
      cursorPath: join(root, "cursor.json"),
      ledgerPath: join(root, "ledger.json")
    }
  };
}

describe("resolveKimicodeSourcePaths", () => {
  let isolated: IsolatedSources | null = null;

  beforeEach(async () => {
    isolated = await isolateSources();
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
  });

  it("prefers AGENT_METRICS_KIMICODE_HOME over the default home", () => {
    process.env.AGENT_METRICS_KIMICODE_HOME = "D:/tmp/kimi-home";
    expect(resolveKimicodeSourcePaths()).toEqual({
      homePath: "D:/tmp/kimi-home",
      sessionsRoot: join("D:/tmp/kimi-home", "sessions"),
      sessionIndexPath: join("D:/tmp/kimi-home", "session_index.jsonl")
    });
  });
});
