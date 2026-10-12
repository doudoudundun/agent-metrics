import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
    // The usage record carries the first-token latency measured from the user row
    // (10:00:00 -> 10:00:05); a single assistant row has no observable window, so decode stays null.
    expect(eventLines[2]).toEqual(
      expect.objectContaining({
        type: "token.usage.recorded",
        first_token_latency_ms: 5000,
        decode_duration_ms: null
      })
    );
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

  it("recovers when a previous parser left behind a stale transcript state lock", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);
    const lockPath = join(dirname(paths.transcriptManifestPath), "transcript-state.lock");
    const staleTime = new Date(Date.now() - 60_000);

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "", "utf8");
    await utimes(lockPath, staleTime, staleTime);

    await recordClaudeTranscriptReference({
      manifestPath: paths.transcriptManifestPath,
      transcriptPath,
      workspacePath: repoRoot,
      sessionId: "ses_stale_lock"
    });

    const manifest = JSON.parse(await readFile(paths.transcriptManifestPath, "utf8")) as Array<{
      sessionId?: string;
    }>;
    expect(manifest).toEqual([
      expect.objectContaining({
        sessionId: "ses_stale_lock"
      })
    ]);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives first-token latency and the streaming window from a message's assistant rows", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

    await writeClaudeTranscript(transcriptPath, [
      claudeUserRow("prompt_1", "2026-05-27T10:00:00.000Z"),
      claudeAssistantRow("msg_1", "2026-05-27T10:00:03.000Z", [CLAUDE_THINKING_BLOCK]),
      claudeAssistantRow("msg_1", "2026-05-27T10:00:07.500Z", [CLAUDE_TEXT_BLOCK], "end_turn"),
      claudeUserRow("prompt_2", "2026-05-27T10:01:00.000Z"),
      claudeAssistantRow("msg_2", "2026-05-27T10:01:04.000Z", [CLAUDE_TEXT_BLOCK]),
      claudeAssistantRow("msg_2", "2026-05-27T10:01:09.000Z", [CLAUDE_TEXT_BLOCK], "end_turn")
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

    const usageEvents = (await readJsonLines(paths.eventLogPath)).filter(
      (line) => line.type === "token.usage.recorded"
    );

    // Every assistant row of a message repeats the same flat usage snapshot, so the
    // message yields one event that keeps the first row's timestamp.
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toEqual(
      expect.objectContaining({
        message_id: "msg_1",
        timestamp: "2026-05-27T10:00:03.000Z",
        first_token_latency_ms: 3000,
        decode_duration_ms: 4500
      })
    );
    expect(usageEvents[1]).toEqual(
      expect.objectContaining({
        message_id: "msg_2",
        timestamp: "2026-05-27T10:01:04.000Z",
        first_token_latency_ms: 4000,
        decode_duration_ms: 5000
      })
    );
  });

  it("emits a message's usage event once when its streaming window spans two sync batches", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

    await writeClaudeTranscript(transcriptPath, [
      claudeUserRow("prompt_1", "2026-05-27T10:00:00.000Z"),
      claudeAssistantRow("msg_1", "2026-05-27T10:00:02.000Z", [CLAUDE_THINKING_BLOCK])
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
      claudeAssistantRow("msg_1", "2026-05-27T10:00:08.000Z", [CLAUDE_TEXT_BLOCK], "end_turn"),
      claudeUserRow("prompt_2", "2026-05-27T10:01:00.000Z")
    ]);

    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });

    const eventLines = await readJsonLines(paths.eventLogPath);
    const usageEvents = eventLines.filter((line) => line.type === "token.usage.recorded");

    // The first batch closed the window with a single row, so decode stays null and
    // the later rows of the same message must not produce a second usage event.
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toEqual(
      expect.objectContaining({
        message_id: "msg_1",
        first_token_latency_ms: 2000,
        decode_duration_ms: null
      })
    );
    expect(eventLines.filter((line) => line.type === "assistant.responded")).toHaveLength(1);
  });

  it("leaves first-token latency null when the anchor is implausible or unusable", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

    await writeClaudeTranscript(transcriptPath, [
      claudeUserRow("prompt_1", "2026-05-27T09:00:00.000Z"),
      // Twenty minutes later: the turn sat idle, so the gap is not a first-token latency.
      claudeAssistantRow("msg_1", "2026-05-27T09:20:00.000Z", [CLAUDE_THINKING_BLOCK]),
      claudeAssistantRow("msg_1", "2026-05-27T09:20:05.000Z", [CLAUDE_TEXT_BLOCK], "end_turn"),
      // A user row without a usable timestamp clears the anchor instead of reusing it.
      claudeUserRow("prompt_2", "not-a-timestamp"),
      claudeAssistantRow("msg_2", "2026-05-27T09:21:00.000Z", [CLAUDE_THINKING_BLOCK]),
      claudeAssistantRow("msg_2", "2026-05-27T09:21:02.000Z", [CLAUDE_TEXT_BLOCK], "end_turn")
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

    const usageEvents = (await readJsonLines(paths.eventLogPath)).filter(
      (line) => line.type === "token.usage.recorded"
    );

    // The streaming window survives an unusable anchor: only the latency is dropped.
    expect(usageEvents[0]).toEqual(
      expect.objectContaining({
        message_id: "msg_1",
        first_token_latency_ms: null,
        decode_duration_ms: 5000
      })
    );
    expect(usageEvents[1]).toEqual(
      expect.objectContaining({
        message_id: "msg_2",
        first_token_latency_ms: null,
        decode_duration_ms: 2000
      })
    );
  });

  it("ignores out-of-order and zero-length rows when deriving the decode window", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-transcript-sync-"));
    const transcriptPath = join(repoRoot, "claude-session.jsonl");
    const paths = getAgentMetricsPaths(repoRoot);

    await writeClaudeTranscript(transcriptPath, [
      claudeUserRow("prompt_1", "2026-05-27T10:00:00.000Z"),
      claudeAssistantRow("msg_1", "2026-05-27T10:00:10.000Z", [CLAUDE_THINKING_BLOCK]),
      // Timestamps that run backwards describe no forwarding window.
      claudeAssistantRow("msg_1", "2026-05-27T10:00:04.000Z", [CLAUDE_TEXT_BLOCK], "end_turn"),
      claudeUserRow("prompt_2", "2026-05-27T10:01:00.000Z"),
      claudeAssistantRow("msg_2", "2026-05-27T10:01:03.000Z", [CLAUDE_TEXT_BLOCK]),
      claudeAssistantRow("msg_2", "2026-05-27T10:01:03.000Z", [CLAUDE_TEXT_BLOCK], "end_turn")
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

    const usageEvents = (await readJsonLines(paths.eventLogPath)).filter(
      (line) => line.type === "token.usage.recorded"
    );

    expect(usageEvents[0]).toEqual(
      expect.objectContaining({
        message_id: "msg_1",
        first_token_latency_ms: 10000,
        decode_duration_ms: null
      })
    );
    expect(usageEvents[1]).toEqual(
      expect.objectContaining({
        message_id: "msg_2",
        first_token_latency_ms: 3000,
        decode_duration_ms: null
      })
    );
  });
});

const CLAUDE_USAGE_SNAPSHOT: Record<string, unknown> = {
  input_tokens: 12,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 1,
  server_tool_use: { web_search_requests: 0 }
};

const CLAUDE_THINKING_BLOCK: Record<string, unknown> = {
  type: "thinking",
  thinking: "weighing options"
};

const CLAUDE_TEXT_BLOCK: Record<string, unknown> = {
  type: "text",
  text: "Done."
};

function claudeUserRow(promptId: string, timestamp: string): Record<string, unknown> {
  return {
    type: "user",
    sessionId: "ses_1",
    promptId,
    timestamp,
    message: {
      role: "user",
      content: "Ship it."
    }
  };
}

function claudeAssistantRow(
  messageId: string,
  timestamp: string,
  content: Array<Record<string, unknown>>,
  stopReason?: string
): Record<string, unknown> {
  return {
    type: "assistant",
    sessionId: "ses_1",
    timestamp,
    message: {
      id: messageId,
      role: "assistant",
      model: "sonnet-test",
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      content,
      usage: CLAUDE_USAGE_SNAPSHOT
    }
  };
}

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
