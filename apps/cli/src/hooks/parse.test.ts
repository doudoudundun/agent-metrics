import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as claudeAdapter from "@agent-metrics/adapters-claude";
import { handleHookEvent } from "./collect.js";
import { parseRawHooksOnce } from "./parser.js";
import { getHookPaths } from "./paths.js";

beforeEach(() => {
  delete process.env.AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS;
});

describe("parseRawHooksOnce", () => {
  it("replays legacy raw hook payloads without envelope metadata", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const paths = getHookPaths(repoRoot);

    await mkdir(join(paths.rawHookLogPath, ".."), { recursive: true });
    await writeFile(
      paths.rawHookLogPath,
      JSON.stringify({
        session_id: "ses_legacy",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool_legacy_1",
        timestamp: "2026-06-08T12:00:00.000Z"
      }) + "\n",
      "utf8"
    );

    await parseRawHooksOnce({ repoRoot });

    const eventLines = await readJsonLines(paths.eventLogPath);
    const parserState = JSON.parse(await readFile(paths.parserStatePath, "utf8")) as {
      nextLine: number;
      seenRawEventIds: string[];
    };

    expect(eventLines).toHaveLength(1);
    expect(eventLines[0]).toMatchObject({
      type: "tool.called",
      session_id: "ses_legacy",
      tool_name: "Read"
    });
    expect(parserState.nextLine).toBe(1);
    expect(parserState.seenRawEventIds).toHaveLength(1);
  });

  it("skips malformed raw hook lines without dropping the whole file", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const paths = getHookPaths(repoRoot);

    await mkdir(join(paths.rawHookLogPath, ".."), { recursive: true });
    await writeFile(
      paths.rawHookLogPath,
      [
        "{bad json",
        JSON.stringify({
          session_id: "ses_after_bad_line",
          cwd: repoRoot,
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_use_id: "tool_after_bad_line",
          timestamp: "2026-06-08T12:00:00.000Z"
        })
      ].join("\n") + "\n",
      "utf8"
    );

    await parseRawHooksOnce({ repoRoot });

    const eventLines = await readJsonLines(paths.eventLogPath);
    const parserState = JSON.parse(await readFile(paths.parserStatePath, "utf8")) as {
      nextLine: number;
      seenRawEventIds: string[];
    };

    expect(eventLines).toHaveLength(1);
    expect(eventLines[0]).toMatchObject({
      type: "tool.called",
      session_id: "ses_after_bad_line"
    });
    expect(parserState.nextLine).toBe(2);
  });

  it("replays raw envelopes, syncs transcript events, and dedupes on rerun", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const filePath = join(repoRoot, "src", "app.ts");
    const transcriptPath = join(repoRoot, "claude-session.jsonl");

    await mkdir(join(repoRoot, "src"), { recursive: true });
    process.env.AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS = join(repoRoot, "missing-claude-projects");
    await writeFile(filePath, "const answer = 1;\n", "utf8");
    await writeClaudeTranscript(transcriptPath, [
      {
        type: "user",
        sessionId: "ses_1",
        cwd: repoRoot,
        promptId: "prompt_1",
        timestamp: "2026-05-27T10:00:00.000Z",
        message: {
          role: "user",
          content: "Ship it."
        }
      },
      {
        type: "assistant",
        sessionId: "ses_1",
        cwd: repoRoot,
        timestamp: "2026-05-27T10:00:05.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "sonnet-test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1,
            server_tool_use: { web_search_requests: 0 }
          }
        }
      }
    ]);

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_use_id: "tool_parse_1",
        transcript_path: transcriptPath,
        tool_input: {
          file_path: "src/app.ts"
        }
      }
    });

    await writeFile(filePath, "const answer = 2;\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "tool_parse_1",
        transcript_path: transcriptPath,
        duration_ms: 25,
        tool_input: {
          file_path: "src/app.ts"
        }
      }
    });

    await parseRawHooksOnce({ repoRoot });
    await parseRawHooksOnce({ repoRoot });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);
    const parserState = JSON.parse(await readFile(paths.parserStatePath, "utf8")) as {
      nextLine: number;
      seenRawEventIds: string[];
    };

    expect(eventLines).toHaveLength(6);
    expect(eventLines.filter((line) => line.type === "tool.called")).toHaveLength(1);
    expect(eventLines.filter((line) => line.type === "tool.succeeded")).toHaveLength(1);
    expect(eventLines.filter((line) => line.type === "code.edit.applied")).toHaveLength(1);
    expect(eventLines.filter((line) => line.type === "prompt.submitted")).toHaveLength(1);
    expect(eventLines.filter((line) => line.type === "assistant.responded")).toHaveLength(1);
    expect(eventLines.filter((line) => line.type === "token.usage.recorded")).toHaveLength(1);
    expect(eventLines.find((line) => line.type === "code.edit.applied")).toMatchObject({
      tool_name: "Edit",
      files_changed: ["src/app.ts"],
      file_count: 1
    });
    expect(parserState.nextLine).toBe(2);
    expect(parserState.seenRawEventIds).toHaveLength(2);
    expect(await listDir(paths.snapshotRoot)).toEqual([]);
  });

  it("syncs the referenced transcript without discovering unrelated Claude projects", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const discoveryRoot = await mkdtemp(join(tmpdir(), "agent-metrics-discovery-"));
    const unrelatedTranscriptPath = join(discoveryRoot, "project", "unrelated.jsonl");

    process.env.AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS = discoveryRoot;
    await mkdir(join(discoveryRoot, "project"), { recursive: true });
    await writeClaudeTranscript(transcriptPath, [
      {
        type: "user",
        sessionId: "ses_1",
        cwd: repoRoot,
        promptId: "prompt_1",
        timestamp: "2026-05-27T10:00:00.000Z",
        message: { role: "user", content: "Ship it." }
      }
    ]);
    await writeClaudeTranscript(unrelatedTranscriptPath, [
      {
        type: "user",
        sessionId: "ses_unrelated",
        cwd: discoveryRoot,
        promptId: "prompt_unrelated",
        timestamp: "2026-05-27T11:00:00.000Z",
        message: { role: "user", content: "Ignore me." }
      }
    ]);

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "SessionStart",
        transcript_path: transcriptPath
      }
    });

    await parseRawHooksOnce({ repoRoot });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.session_id)).toEqual(["ses_1", "ses_1"]);
  });

  it("keeps parsing tool events when transcript state is locked", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getHookPaths(repoRoot);

    await mkdir(join(paths.transcriptManifestPath, ".."), { recursive: true });
    await writeFile(join(paths.transcriptManifestPath, "..", "transcript-state.lock"), "", "utf8");
    await writeClaudeTranscript(transcriptPath, [
      {
        type: "user",
        sessionId: "ses_locked",
        cwd: repoRoot,
        promptId: "prompt_locked",
        timestamp: "2026-05-27T10:00:00.000Z",
        message: { role: "user", content: "Ship it." }
      }
    ]);

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_locked",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool_locked_1",
        transcript_path: transcriptPath
      }
    });

    await writeFile(join(paths.transcriptManifestPath, "..", "transcript-state.lock"), "", "utf8");
    await parseRawHooksOnce({ repoRoot });

    const eventLines = await readJsonLines(paths.eventLogPath);
    const parserState = JSON.parse(await readFile(paths.parserStatePath, "utf8")) as {
      nextLine: number;
      seenRawEventIds: string[];
    };

    expect(eventLines.some((line) => line.type === "tool.called")).toBe(true);
    expect(parserState.nextLine).toBe(1);
  });

  it("keeps hook-derived events flowing when transcript sync throws", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const syncSpy = vi
      .spyOn(claudeAdapter, "syncKnownClaudeTranscripts")
      .mockRejectedValueOnce(new Error("sync failed"));

    await writeClaudeTranscript(transcriptPath, [
      {
        type: "user",
        sessionId: "ses_sync_failure",
        cwd: repoRoot,
        promptId: "prompt_sync_failure",
        timestamp: "2026-05-27T10:00:00.000Z",
        message: { role: "user", content: "Ship it." }
      }
    ]);

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_sync_failure",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool_sync_failure_1",
        transcript_path: transcriptPath
      }
    });

    await expect(parseRawHooksOnce({ repoRoot })).resolves.toBeUndefined();

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.some((line) => line.type === "tool.called")).toBe(true);
    syncSpy.mockRestore();
  });
});

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(filePath, "utf8");

  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

async function writeClaudeTranscript(
  transcriptPath: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const contents = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(transcriptPath, contents, "utf8");
}
