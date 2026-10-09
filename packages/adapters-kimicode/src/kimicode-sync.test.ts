import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolateSources, type IsolatedSources } from "@agent-metrics/test-utils";
import { resolveKimicodeSourcePaths, syncKimicodeSessions } from "./kimicode-sync.js";

describe("syncKimicodeSessions", () => {
  let isolated: IsolatedSources | null = null;

  beforeEach(async () => {
    isolated = await isolateSources();
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
  });

  it("syncs session_index and wire usage into kimicode events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-metrics-kimicode-"));
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
});

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
