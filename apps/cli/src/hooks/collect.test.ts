import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildHookPayloadFromInput, handleHookEvent } from "./collect.js";
import { getHookPaths } from "./paths.js";

describe("handleHookEvent", () => {
  it("writes one raw envelope per hook invocation", async () => {
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
      raw_event_id: expect.any(String),
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Read"
      }
    });
  });

  it("writes raw envelopes without appending normalized events for a successful tool flow", async () => {
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
    const rawLines = await readJsonLines(paths.rawHookLogPath);
    const eventFile = await tryReadFile(paths.eventLogPath);

    expect(rawLines).toHaveLength(2);
    expect(rawLines.map((line) => line.hook_event_name)).toEqual(["PreToolUse", "PostToolUse"]);
    expect(eventFile).toBeNull();
  });

  it("captures snapshot sidecars for Bash rm targets during PreToolUse", async () => {
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

    const paths = getHookPaths(repoRoot);

    expect(await listDir(paths.snapshotRoot)).toEqual(["tool_bash_rm.json"]);
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
    expect(rawLines[0]).toMatchObject({
      hook_event_name: "Notification"
    });
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

    const eventFile = await tryReadFile(paths.eventLogPath);

    expect(eventFile).toBeNull();
    expect(await listDir(paths.snapshotRoot)).toEqual([]);
  });

  it("uses repoRoot as workspace_path fallback when cwd is missing", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_1",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool_no_cwd",
        tool_input: {
          file_path: "src/app.ts"
        }
      }
    });

    const paths = getHookPaths(repoRoot);
    const rawLines = await readJsonLines(paths.rawHookLogPath);

    expect(rawLines.map((line) => line.workspace_path)).toEqual([repoRoot]);
    expect(rawLines[0]?.payload).toMatchObject({
      cwd: repoRoot
    });
  });

  it("registers transcript_path into the transcript manifest", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_transcript",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        transcript_path: transcriptPath
      }
    });

    const paths = getHookPaths(repoRoot);
    const manifest = JSON.parse(await readFile(paths.transcriptManifestPath, "utf8")) as unknown[];

    expect(manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transcriptPath,
          workspacePath: repoRoot,
          sessionId: "ses_transcript"
        })
      ])
    );
  });

  it("keeps hook collection successful when transcript manifest is locked", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getHookPaths(repoRoot);

    await mkdir(dirname(paths.transcriptManifestPath), { recursive: true });
    await writeFile(join(dirname(paths.transcriptManifestPath), "transcript-state.lock"), "", "utf8");

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_locked",
        cwd: repoRoot,
        hook_event_name: "SessionStart",
        transcript_path: transcriptPath
      }
    });

    const rawLines = await readJsonLines(paths.rawHookLogPath);

    expect(rawLines).toHaveLength(1);
    expect(rawLines[0]).toMatchObject({
      hook_event_name: "SessionStart",
      payload: {
        session_id: "ses_locked"
      }
    });
  });

  it("normalizes a relative cwd against repoRoot before recording transcript metadata", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-hooks-"));
    const transcriptPath = "transcripts/session.jsonl";

    await handleHookEvent({
      repoRoot,
      payload: {
        session_id: "ses_relative",
        cwd: "workspace",
        hook_event_name: "PreToolUse",
        transcript_path: transcriptPath
      }
    });

    const paths = getHookPaths(repoRoot);
    const manifest = JSON.parse(await readFile(paths.transcriptManifestPath, "utf8")) as Array<{
      transcriptPath: string;
      workspacePath: string;
      sessionId?: string;
    }>;

    expect(manifest).toEqual([
      {
        transcriptPath: join(repoRoot, "workspace", "transcripts", "session.jsonl"),
        workspacePath: join(repoRoot, "workspace"),
        sessionId: "ses_relative"
      }
    ]);
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

    const paths = getHookPaths(repoRoot);
    const escapedSnapshotPath = resolve(paths.snapshotRoot, "..", "..", "escaped.json");

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

    const paths = getHookPaths(repoRoot);

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
