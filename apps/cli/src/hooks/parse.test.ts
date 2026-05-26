import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { handleHookEvent } from "./collect.js";
import { parseRawHooksOnce } from "./parser.js";
import { getHookPaths } from "./paths.js";

describe("parseRawHooksOnce", () => {
  it("replays raw envelopes into normalized events and dedupes on rerun", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-parse-"));
    const filePath = join(repoRoot, "src", "app.ts");

    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(filePath, "const answer = 1;\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_use_id: "tool_parse_1",
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

    expect(eventLines.map((line) => line.type)).toEqual([
      "tool.called",
      "tool.succeeded",
      "code.edit.applied"
    ]);
    expect(eventLines[2]).toMatchObject({
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
