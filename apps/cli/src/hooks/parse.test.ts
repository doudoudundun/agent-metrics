import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { handleHookEvent } from "./collect.js";
import { parseRawHooksOnce } from "./parser.js";
import { getHookPaths } from "./paths.js";

describe("parseRawHooksOnce", () => {
  it("replays raw envelopes, syncs transcript events, and dedupes on rerun", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const filePath = join(repoRoot, "src", "app.ts");
    const transcriptPath = join(repoRoot, "claude-session.jsonl");

    await mkdir(join(repoRoot, "src"), { recursive: true });
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
