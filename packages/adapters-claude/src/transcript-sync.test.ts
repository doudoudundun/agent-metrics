import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getAgentMetricsPaths } from "@agent-metrics/shared-utils";
import {
  recordClaudeTranscriptReference,
  syncKnownClaudeTranscripts
} from "./transcript-sync.js";

describe("syncKnownClaudeTranscripts", () => {
  it("appends one prompt, assistant, and usage event once across reruns", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

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

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_1"
    });

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines).toHaveLength(3);
    expect(eventLines.map((line) => line.type)).toEqual([
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);
  });

  it("catches up newly appended transcript bytes without duplicating earlier events", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

    await writeClaudeTranscript(transcriptPath, [
      {
        type: "user",
        sessionId: "ses_1",
        cwd: repoRoot,
        promptId: "prompt_1",
        timestamp: "2026-05-27T10:00:00.000Z",
        message: {
          role: "user",
          content: "First"
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
          content: [{ type: "text", text: "One" }],
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

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_1"
    });

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    await appendClaudeTranscript(transcriptPath, [
      {
        type: "user",
        sessionId: "ses_1",
        cwd: repoRoot,
        promptId: "prompt_2",
        timestamp: "2026-05-27T10:01:00.000Z",
        message: {
          role: "user",
          content: "Second"
        }
      },
      {
        type: "assistant",
        sessionId: "ses_1",
        cwd: repoRoot,
        timestamp: "2026-05-27T10:01:05.000Z",
        message: {
          id: "msg_2",
          role: "assistant",
          model: "sonnet-test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Two" }],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1,
            server_tool_use: { web_search_requests: 0 }
          }
        }
      }
    ]);

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines).toHaveLength(6);
    expect(eventLines.filter((line) => line.type === "prompt.submitted")).toHaveLength(2);
    expect(eventLines.filter((line) => line.type === "assistant.responded")).toHaveLength(2);
    expect(eventLines.filter((line) => line.type === "token.usage.recorded")).toHaveLength(2);
  });

  it("waits for a partial trailing line to complete before emitting transcript events", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);
    const partialAssistantRow =
      '{"type":"assistant","sessionId":"ses_1","cwd":"' +
      repoRoot.replaceAll("\\", "\\\\") +
      '","timestamp":"2026-05-27T10:00:05.000Z","message":{"id":"msg_1","role":"assistant","model":"sonnet-test","stop_reason":"end_turn","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":12,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":1,"server_tool_use":{"web_search_requests":0}}}}';

    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        sessionId: "ses_1",
        cwd: repoRoot,
        promptId: "prompt_1",
        timestamp: "2026-05-27T10:00:00.000Z",
        message: {
          role: "user",
          content: "Ship it."
        }
      })}\n${partialAssistantRow.slice(0, Math.floor(partialAssistantRow.length / 2))}`,
      "utf8"
    );

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_1"
    });

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    expect(await readJsonLines(paths.eventLogPath)).toHaveLength(1);

    await appendFile(
      transcriptPath,
      `${partialAssistantRow.slice(Math.floor(partialAssistantRow.length / 2))}\n`,
      "utf8"
    );

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    const eventLines = await readJsonLines(paths.eventLogPath);

    expect(eventLines).toHaveLength(3);
    expect(eventLines.map((line) => line.type)).toEqual([
      "prompt.submitted",
      "assistant.responded",
      "token.usage.recorded"
    ]);
  });

  it("preserves an existing sessionId when the same transcript is registered again without one", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_1"
    });
    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot
    });

    const manifest = JSON.parse(await readFile(paths.transcriptManifestPath, "utf8")) as Array<{
      transcriptPath: string;
      workspacePath: string;
      sessionId?: string;
    }>;

    expect(manifest).toEqual([
      {
        transcriptPath,
        workspacePath: repoRoot,
        sessionId: "ses_1"
      }
    ]);
  });

  it("reuses existing transcript events from the event log when ledger state is missing", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

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

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_1"
    });

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    await rm(paths.transcriptCursorPath);
    await rm(paths.transcriptLedgerPath);

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    expect(await readJsonLines(paths.eventLogPath)).toHaveLength(3);
  });

  it("discovers background sdk-cli transcripts and extracts execution-path and skill metadata", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-discovery-"));
    const workspacePath = join(repoRoot, "master_os170");
    const executionPath = join(workspacePath, ".claude", "tmp");
    const transcriptRoot = join(repoRoot, ".claude", "projects");
    const transcriptPath = join(transcriptRoot, "master_os170--claude-tmp", "session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

    await writeClaudeTranscript(transcriptPath, [
      {
        type: "user",
        sessionId: "ses_background_1",
        cwd: executionPath,
        promptId: "prompt_1",
        timestamp: "2026-05-29T10:00:00.000Z",
        message: {
          role: "user",
          content: "Analyze recent commits"
        }
      },
      {
        type: "assistant",
        sessionId: "ses_background_1",
        cwd: executionPath,
        timestamp: "2026-05-29T10:00:02.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-sonnet",
          stop_reason: "end_turn",
          content: [
            {
              type: "tool_result",
              content: [
                {
                  type: "skill_listing",
                  skills: [
                    { name: "commit-analyzer" },
                    { id: "project-rules" }
                  ]
                }
              ]
            },
            { type: "text", text: "Analysis complete." }
          ],
          usage: {
            input_tokens: 42,
            output_tokens: 8,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 3,
            server_tool_use: { web_search_requests: 0 }
          }
        }
      }
    ]);

    const result = await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: [transcriptRoot]
    });

    expect(await readJsonLines(paths.eventLogPath)).toHaveLength(3);
    expect(result.sessionContexts).toEqual([
      {
        sessionId: "ses_background_1",
        workspacePath,
        executionPath,
        skillsLoaded: true,
        skillNames: ["commit-analyzer", "project-rules"],
        sourceAdapter: "claude-transcript",
        sourceVendor: "claude-code",
        updatedAt: "2026-05-29T10:00:02.000Z"
      }
    ]);

    const manifest = JSON.parse(await readFile(paths.transcriptManifestPath, "utf8")) as Array<{
      transcriptPath: string;
      workspacePath: string;
      sessionId?: string;
    }>;

    expect(manifest).toEqual([
      {
        transcriptPath,
        workspacePath,
        sessionId: "ses_background_1"
      }
    ]);
  });
});

async function writeClaudeTranscript(
  transcriptPath: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const contents = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await mkdir(dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, contents, "utf8");
}

async function appendClaudeTranscript(
  transcriptPath: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  const contents = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await appendFile(transcriptPath, contents, "utf8");
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(filePath, "utf8");

  return contents
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
