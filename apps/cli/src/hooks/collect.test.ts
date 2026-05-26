import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildHookPayloadFromInput, handleHookEvent } from "./collect.js";
import { getHookPaths } from "./paths.js";

describe("handleHookEvent", () => {
  it("writes one raw log line per hook invocation", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {
          file_path: "README.md"
        }
      }
    });

    const paths = getHookPaths(repoRoot);
    const rawLines = await readJsonLines(paths.rawHookLogPath);

    expect(rawLines).toHaveLength(1);
    expect(rawLines[0]).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "Read"
    });
  });

  it("writes normalized tool events for a successful tool flow", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool_1",
        tool_input: {
          file_path: "README.md"
        }
      }
    });

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_use_id: "tool_1",
        duration_ms: 12
      }
    });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.type)).toEqual(["tool.called", "tool.succeeded"]);
  });

  it("writes code.edit.applied when an Edit target changes", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
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
        tool_use_id: "tool_2",
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
        tool_use_id: "tool_2",
        duration_ms: 25,
        tool_input: {
          file_path: "src/app.ts"
        }
      }
    });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.type)).toEqual([
      "tool.called",
      "tool.succeeded",
      "code.edit.applied"
    ]);
    expect(eventLines[2]).toMatchObject({
      tool_name: "Edit",
      files_changed: ["src/app.ts"],
      file_count: 1,
      insertions: 1,
      deletions: 1,
      edit_operation_count: 1
    });
  });

  it("writes code.edit.applied when Bash deletes a file with rm", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const filePath = join(repoRoot, "src", "app.ts");

    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(filePath, "const answer = 1;\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tool_bash_rm",
        tool_input: {
          command: "rm src/app.ts"
        }
      }
    });

    await unlink(filePath);

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tool_bash_rm",
        duration_ms: 25,
        tool_input: {
          command: "rm src/app.ts"
        }
      }
    });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.type)).toEqual([
      "tool.called",
      "tool.succeeded",
      "code.edit.applied"
    ]);
    expect(eventLines[2]).toMatchObject({
      tool_name: "Bash",
      files_changed: ["src/app.ts"],
      file_count: 1,
      insertions: 0,
      deletions: 1,
      edit_operation_count: 1
    });
  });

  it("writes code.edit.applied when Bash edits a file with sed -i", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const filePath = join(repoRoot, "src", "app.ts");

    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tool_bash_sed",
        tool_input: {
          command: "sed -i '2d' src/app.ts"
        }
      }
    });

    await writeFile(filePath, "alpha\ngamma\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tool_bash_sed",
        duration_ms: 25,
        tool_input: {
          command: "sed -i '2d' src/app.ts"
        }
      }
    });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.type)).toEqual([
      "tool.called",
      "tool.succeeded",
      "code.edit.applied"
    ]);
    expect(eventLines[2]).toMatchObject({
      tool_name: "Bash",
      files_changed: ["src/app.ts"],
      file_count: 1,
      insertions: 0,
      deletions: 1,
      edit_operation_count: 1
    });
  });

  it("still writes raw logs for unknown hook events", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "Notification"
      }
    });

    const paths = getHookPaths(repoRoot);
    const rawLines = await readJsonLines(paths.rawHookLogPath);
    const eventFile = await tryReadFile(paths.eventLogPath);

    expect(rawLines).toHaveLength(1);
    expect(eventFile).toBeNull();
  });

  it("cleans up snapshots when a mutating tool fails", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
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
        tool_use_id: "tool_fail",
        tool_input: {
          file_path: "src/app.ts"
        }
      }
    });

    const paths = getHookPaths(repoRoot);
    expect(await listDir(paths.snapshotRoot)).toEqual(["tool_fail.json"]);

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Edit",
        tool_use_id: "tool_fail"
      }
    });

    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.type)).toEqual(["tool.called", "tool.failed"]);
    expect(await listDir(paths.snapshotRoot)).toEqual([]);
  });

  it("uses repoRoot as workspace_path fallback when cwd is missing", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const filePath = join(repoRoot, "src", "app.ts");

    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(filePath, "const answer = 1;\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_use_id: "tool_no_cwd",
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
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "tool_no_cwd"
      }
    });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.workspace_path)).toEqual([repoRoot, repoRoot, repoRoot]);
  });

  it("rejects malformed tool_use_id values that would escape the snapshot root", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
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
        tool_use_id: "../../escaped",
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
        tool_use_id: "../../escaped"
      }
    });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);
    const escapedSnapshotPath = resolve(paths.snapshotRoot, "..", "..", "escaped.json");

    expect(eventLines.map((line) => line.type)).toEqual(["tool.called", "tool.succeeded"]);
    expect(await tryReadFile(escapedSnapshotPath)).toBeNull();
    expect(await listDir(paths.snapshotRoot)).toEqual([]);
  });

  it("rejects mutation targets that would escape the workspace boundary", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const outsideFilePath = resolve(repoRoot, "..", "outside.ts");

    await writeFile(outsideFilePath, "export const answer = 1;\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_use_id: "tool_outside",
        tool_input: {
          file_path: "../outside.ts"
        }
      }
    });

    await writeFile(outsideFilePath, "export const answer = 2;\n", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        cwd: repoRoot,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "tool_outside"
      }
    });

    const paths = getHookPaths(repoRoot);
    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines.map((line) => line.type)).toEqual(["tool.called", "tool.succeeded"]);
    expect(await listDir(paths.snapshotRoot)).toEqual([]);
  });
});

describe("buildHookPayloadFromInput", () => {
  it("skips empty or malformed stdin payloads", () => {
    expect(
      buildHookPayloadFromInput({
        hookEventName: "SessionStart",
        stdinText: ""
      })
    ).toBeNull();

    expect(
      buildHookPayloadFromInput({
        hookEventName: "PostToolUseFailure",
        stdinText: "{not valid json"
      })
    ).toBeNull();
  });

  it("adds the CLI hook event name when stdin JSON omits it", () => {
    expect(
      buildHookPayloadFromInput({
        hookEventName: "SessionStart",
        stdinText: JSON.stringify({
          session_id: "ses_1",
          cwd: "D:/tmp/workspace"
        })
      })
    ).toEqual({
      session_id: "ses_1",
      cwd: "D:/tmp/workspace",
      hook_event_name: "SessionStart"
    });
  });

  it("preserves the stdin hook event name when one is already present", () => {
    expect(
      buildHookPayloadFromInput({
        hookEventName: "SessionStart",
        stdinText: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Read"
        })
      })
    ).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Read"
    });
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

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function listDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}
