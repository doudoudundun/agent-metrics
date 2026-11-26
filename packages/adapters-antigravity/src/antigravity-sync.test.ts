import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolateSources, type IsolatedSources } from "@agent-metrics/test-utils";
import {
  resolveAntigravitySourcePaths,
  syncAntigravityAcpSessions
} from "./antigravity-sync.js";

type SyncInput = {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  providersRoot?: string;
};

type TranscriptEvent = Record<string, unknown> & { type?: string };

function userInput(step: number, createdAt: string, content: string): TranscriptEvent {
  return {
    step_index: step,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    created_at: createdAt,
    content
  };
}

function plannerResponse(
  step: number,
  createdAt: string,
  model: string,
  tokens: { input_tokens?: number; cache_read_tokens?: number; output_tokens?: number },
  extra: Record<string, unknown> = {}
): TranscriptEvent {
  return {
    step_index: step,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: createdAt,
    model,
    ...tokens,
    ...extra
  };
}

function toLines(records: TranscriptEvent[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

async function readEvents(path: string): Promise<TranscriptEvent[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TranscriptEvent);
}

async function writeTranscript(root: string, account: string, sessionId: string, records: TranscriptEvent[]) {
  const transcriptPath = join(
    root,
    account,
    "antigravity-acp",
    "brain",
    sessionId,
    ".system_generated",
    "logs",
    "transcript_full.jsonl"
  );
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, toLines(records));
  return transcriptPath;
}

async function bumpMtime(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, new Date(now.getTime() + 10_000));
}

describe("syncAntigravityAcpSessions", () => {
  let isolated: IsolatedSources | null = null;
  let root: string;
  let previousEnv: string | undefined;

  beforeEach(async () => {
    isolated = await isolateSources();
    root = await mkdtemp(join(tmpdir(), "agent-metrics-antigravity-"));
    previousEnv = process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT;
    process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT = join(root, "missing-root");
  });

  afterEach(async () => {
    isolated?.cleanup();
    isolated = null;
    if (previousEnv === undefined) {
      delete process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT;
    } else {
      process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT = previousEnv;
    }
    await rm(root, { recursive: true, force: true });
  });

  function syncInput(overrides: Partial<SyncInput> = {}): SyncInput {
    return {
      eventLogPath: join(root, "events.jsonl"),
      cursorPath: join(root, "cursor.json"),
      ledgerPath: join(root, "ledger.json"),
      ...overrides
    };
  }

  it("syncs planner/worker sessions with cache-read above input and no duplicates on rerun", async () => {
    const providersRoot = join(root, "providers");
    await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "fix the flaky test"),
      plannerResponse(
        1,
        "2026-11-23T14:49:40Z",
        "gemini-pro-orchestrator-neon",
        { input_tokens: 3573, cache_read_tokens: 33090, output_tokens: 353 },
        { thinking: "planning", content: "running the worker" }
      ),
      plannerResponse(
        3,
        "2026-11-23T14:50:12Z",
        "gemini-flash-worker-agy",
        { input_tokens: 6808, cache_read_tokens: 36664, output_tokens: 617 },
        { tool_calls: [{ name: "run_tests" }] }
      )
    ]);
    await writeTranscript(providersRoot, "account-a", "session-2", [
      userInput(0, "2026-11-23T15:02:01Z", "second session"),
      plannerResponse(
        1,
        "2026-11-23T15:02:30Z",
        "gemini-4-argon-high",
        { input_tokens: 10, cache_read_tokens: 0, output_tokens: 5 },
        { content: "done", thinking: "" }
      )
    ]);

    const input = syncInput({ providersRoot });
    await syncAntigravityAcpSessions(input);

    const events = await readEvents(input.eventLogPath);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded",
      "assistant.responded",
      "token.usage.recorded",
      "session.started",
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);
    expect(events.every((event) => event.source_vendor === "antigravity")).toBe(true);
    expect(events.every((event) => event.source_adapter === "antigravity-acp")).toBe(true);
    expect(events.every((event) => event.workspace_path === ".")).toBe(true);
    expect(events.every((event) => event.schema_version === 2)).toBe(true);

    expect(events.filter((event) => event.session_id === "session-1")).toHaveLength(6);
    expect(events.filter((event) => event.session_id === "session-2")).toHaveLength(4);

    const prompt = events.find((event) => event.type === "prompt.submitted");
    expect(prompt).toMatchObject({ prompt_chars: 18, session_id: "session-1" });
    expect(JSON.stringify(events)).not.toContain("fix the flaky test");

    const usages = events.filter((event) => event.type === "token.usage.recorded");
    expect(usages.map((usage) => usage.model)).toEqual([
      "gemini-pro-orchestrator-neon",
      "gemini-flash-worker-agy",
      "gemini-4-argon-high"
    ]);
    for (const usage of usages) {
      expect(usage).toMatchObject({
        usage_source: "antigravity-acp",
        input_token_semantics: "delta",
        usage_measurement: "increment",
        cache_creation_input_tokens: 0,
        provider_id: "google"
      });
    }
    expect(usages[0]).toMatchObject({ input_tokens: 3573, cache_read_input_tokens: 33090, output_tokens: 353 });
    expect(usages[0].cache_read_input_tokens as number).toBeGreaterThan(usages[0].input_tokens as number);

    const assistants = events.filter((event) => event.type === "assistant.responded");
    expect(assistants.map((assistant) => assistant.response_chars)).toEqual([18, 0, 4]);

    await syncAntigravityAcpSessions(input);
    const rerun = await readEvents(input.eventLogPath);
    expect(rerun).toHaveLength(events.length);
  });

  it("reads only transcript_full.jsonl and ignores sibling stores", async () => {
    const providersRoot = join(root, "providers");
    const transcriptPath = await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "hi"),
      plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 4, output_tokens: 2 })
    ]);
    const sessionRoot = join(providersRoot, "account-a", "antigravity-acp", "brain", "session-1");
    await writeFile(join(sessionRoot, "statev2.json"), "{}");
    await writeFile(
      join(sessionRoot, ".system_generated", "auth.json"),
      JSON.stringify({ token: "would-be-secret" })
    );
    await mkdir(join(sessionRoot, ".system_generated", "cache"), { recursive: true });
    await writeFile(
      join(sessionRoot, ".system_generated", "cache", "cache.jsonl"),
      toLines([plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 999_999 })])
    );
    await mkdir(join(sessionRoot, ".system_generated", "chunks"), { recursive: true });
    await writeFile(
      join(sessionRoot, ".system_generated", "chunks", "chunk-1.jsonl"),
      toLines([plannerResponse(2, "2026-11-23T14:49:25Z", "gemini-4-argon-high", { input_tokens: 888_888 })])
    );
    await mkdir(join(providersRoot, "account-a", "antigravity-acp", "not-brain"), { recursive: true });
    await writeFile(
      join(providersRoot, "account-a", "antigravity-acp", "not-brain", "transcript_full.jsonl"),
      toLines([plannerResponse(3, "2026-11-23T14:49:30Z", "gemini-4-argon-high", { input_tokens: 777_777 })])
    );

    const input = syncInput({ providersRoot });
    await syncAntigravityAcpSessions(input);

    const events = await readEvents(input.eventLogPath);
    expect(events).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain("999999");
    expect(JSON.stringify(events)).not.toContain("888888");
    expect(JSON.stringify(events)).not.toContain("777777");
    expect(JSON.stringify(events)).not.toContain("would-be-secret");

    const cursor = JSON.parse(await readFile(input.cursorPath, "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(cursor.files)).toEqual([transcriptPath]);
  });

  it("appends only new events after the transcript grows", async () => {
    const providersRoot = join(root, "providers");
    const transcriptPath = await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "one"),
      plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 4, output_tokens: 2 })
    ]);

    const input = syncInput({ providersRoot });
    await syncAntigravityAcpSessions(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);

    await appendFile(
      transcriptPath,
      toLines([
        userInput(2, "2026-11-23T14:50:00Z", "two"),
        plannerResponse(3, "2026-11-23T14:50:09Z", "gemini-flash-worker-agy", { input_tokens: 50, cache_read_tokens: 500 })
      ])
    );
    await syncAntigravityAcpSessions(input);

    const events = await readEvents(input.eventLogPath);
    expect(events).toHaveLength(7);
    expect(events.slice(-3).map((event) => event.type)).toEqual([
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);
  });

  it("tolerates a half-written trailing record and picks it up once completed", async () => {
    const providersRoot = join(root, "providers");
    const transcriptPath = await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "complete")
    ]);
    const partial = JSON.stringify(
      plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 4, output_tokens: 2 })
    );
    const splitAt = partial.indexOf('"gemini') + 3;
    await appendFile(transcriptPath, partial.slice(0, splitAt));

    const input = syncInput({ providersRoot });
    await syncAntigravityAcpSessions(input);
    let events = await readEvents(input.eventLogPath);
    expect(events.map((event) => event.type)).toEqual(["session.started", "prompt.submitted"]);

    await appendFile(transcriptPath, partial.slice(splitAt) + "\n");
    await syncAntigravityAcpSessions(input);
    events = await readEvents(input.eventLogPath);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);

    await syncAntigravityAcpSessions(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);
  });

  it("skips corrupt lines but keeps the surrounding records", async () => {
    const providersRoot = join(root, "providers");
    const transcriptPath = await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "before")
    ]);
    await appendFile(transcriptPath, "{not json at all\n");
    await appendFile(
      transcriptPath,
      toLines([
        plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 4, output_tokens: 2 })
      ])
    );

    const input = syncInput({ providersRoot });
    await syncAntigravityAcpSessions(input);

    const events = await readEvents(input.eventLogPath);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);
  });

  it("re-reads a rewritten transcript when only the mtime signals the change", async () => {
    const providersRoot = join(root, "providers");
    const transcriptPath = await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "same length prompt"),
      plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 4, output_tokens: 2 })
    ]);

    const input = syncInput({ providersRoot });
    await syncAntigravityAcpSessions(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);

    // Same byte length (step 1 -> 2 keeps every digit single): only the mtime
    // tells the cursor the file was rewritten, and the re-read must surface the
    // new step while the ledger suppresses the unchanged records.
    await writeFile(
      transcriptPath,
      toLines([
        userInput(0, "2026-11-23T14:49:14Z", "same length prompt"),
        plannerResponse(2, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 4, output_tokens: 2 })
      ])
    );
    await bumpMtime(transcriptPath);
    await syncAntigravityAcpSessions(input);

    const events = await readEvents(input.eventLogPath);
    expect(events).toHaveLength(6);
    const usages = events.filter((event) => event.type === "token.usage.recorded");
    expect(usages.map((usage) => usage.message_id)).toEqual([
      "antigravity:session-1:step:1:gemini-4-argon-high",
      "antigravity:session-1:step:2:gemini-4-argon-high"
    ]);
  });

  it("does nothing when the providers root is missing and survives a lost ledger", async () => {
    const input = syncInput();
    await syncAntigravityAcpSessions(input);
    expect(existsSync(input.eventLogPath)).toBe(false);
    expect(existsSync(input.cursorPath)).toBe(false);
    expect(existsSync(input.ledgerPath)).toBe(false);

    const providersRoot = join(root, "providers");
    await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "ledger"),
      plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 7, cache_read_tokens: 70 })
    ]);
    const full = { ...input, providersRoot };
    await syncAntigravityAcpSessions(full);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);

    await rm(input.ledgerPath, { force: true });
    await rm(input.cursorPath, { force: true });
    await syncAntigravityAcpSessions(full);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);
  });

  it("tolerates a transcript disappearing between syncs", async () => {
    const providersRoot = join(root, "providers");
    const transcriptPath = await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "vanishing"),
      plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 3, output_tokens: 1 })
    ]);

    const input = syncInput({ providersRoot });
    await syncAntigravityAcpSessions(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);

    await rm(transcriptPath, { force: true });
    await syncAntigravityAcpSessions(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);
  });

  it("follows the providers root env var when no explicit root is passed", async () => {
    const providersRoot = join(root, "providers-env");
    await writeTranscript(providersRoot, "account-a", "session-1", [
      userInput(0, "2026-11-23T14:49:14Z", "env routed"),
      plannerResponse(1, "2026-11-23T14:49:20Z", "gemini-4-argon-high", { input_tokens: 9, output_tokens: 9 })
    ]);
    process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT = providersRoot;

    const input = syncInput();
    await syncAntigravityAcpSessions(input);
    expect(await readEvents(input.eventLogPath)).toHaveLength(4);
  });
});

describe("resolveAntigravitySourcePaths", () => {
  let isolated: IsolatedSources | null = null;
  let previousEnv: string | undefined;

  beforeEach(async () => {
    isolated = await isolateSources();
    previousEnv = process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT;
    delete process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT;
  });

  afterEach(() => {
    isolated?.cleanup();
    isolated = null;
    if (previousEnv === undefined) {
      delete process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT;
    } else {
      process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT = previousEnv;
    }
  });

  it("defaults to ~/.t3/userdata/providers/antigravity", () => {
    expect(resolveAntigravitySourcePaths()).toEqual({
      providersRoot: join(homedir(), ".t3", "userdata", "providers", "antigravity")
    });
  });

  it("prefers the env var over the default and an explicit argument over both", () => {
    process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT = "/tmp/env-root";
    expect(resolveAntigravitySourcePaths()).toEqual({ providersRoot: "/tmp/env-root" });

    expect(resolveAntigravitySourcePaths({ providersRoot: "/tmp/explicit-root" })).toEqual({
      providersRoot: "/tmp/explicit-root"
    });
  });
});
