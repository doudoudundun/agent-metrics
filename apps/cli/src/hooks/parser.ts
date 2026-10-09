import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  normalizeNativeId,
  toNormalizedEventV2,
  type EventNormalizationOptions
} from "@agent-metrics/event-schema";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import {
  normalizeClaudeHookEvent,
  normalizeClaudeObservation,
  recordClaudeTranscriptReference,
  syncKnownClaudeTranscripts,
  type ClaudeHookPayload,
  type ClaudeRawEnvelope
} from "@agent-metrics/adapters-claude";
import { getHookPaths } from "./paths.js";
import { loadParserState, saveParserState, tryWithParserStateLock } from "./parser-state.js";
import { parseClaudeRawEnvelope } from "./raw-envelope.js";
import { collectChangedSnapshots } from "./snapshots.js";

const PARSER_STATE_FLUSH_INTERVAL = 100;

export async function parseRawHooksOnce(input: { repoRoot: string }): Promise<void> {
  const paths = getHookPaths(input.repoRoot);
  await tryWithParserStateLock(paths.parserStatePath, async () => {
    const state = await loadParserState(paths.parserStatePath);
    const rawLines = await readJsonLines(paths.rawHookLogPath);
    const pendingLines = rawLines.slice(state.nextLine);
    let processedLines = 0;
    let shouldSyncTranscripts = false;

    for (const line of pendingLines) {
      state.nextLine += 1;
      processedLines += 1;

      const envelope = parseClaudeRawEnvelope(line);
      if (envelope === null || state.seenRawEventIds.includes(envelope.raw_event_id)) {
        await saveParserStatePeriodically(paths.parserStatePath, state, processedLines);
        continue;
      }

      const payload = withFallbackTimestamp(envelope.payload, envelope.captured_at);
      const workspacePath = normalizeWorkspacePath(payload.cwd, input.repoRoot);
      const normalizedPayload = withWorkspacePath(payload, workspacePath);
      const hookOptions = buildHookNormalizationOptions(normalizedPayload, envelope);
      const normalizedEvent = normalizeClaudeHookEvent(normalizedPayload, hookOptions);

      if (normalizedEvent !== null) {
        const v2Event = toNormalizedEventV2(normalizedEvent);
        await appendJsonLine(paths.eventLogPath, v2Event);
      }

      if (normalizedPayload.hook_event_name === "PostToolUse") {
        if (
          typeof normalizedPayload.tool_use_id !== "string" ||
          normalizedPayload.tool_use_id.length === 0
        ) {
          state.seenRawEventIds.push(envelope.raw_event_id);
          await saveParserStatePeriodically(paths.parserStatePath, state, processedLines);
          continue;
        }

        const changedFiles = await collectChangedSnapshots({
          snapshotRoot: paths.snapshotRoot,
          toolUseId: normalizedPayload.tool_use_id
        });

        if (changedFiles.length > 0) {
          const v2EditEvent = toNormalizedEventV2(
            normalizeClaudeObservation(
              {
                sessionId:
                  typeof normalizedPayload.session_id === "string" && normalizedPayload.session_id.length > 0
                    ? normalizedPayload.session_id
                    : "unknown-session",
                workspacePath,
                observation: {
                  kind: "edit_applied",
                  toolName:
                    typeof normalizedPayload.tool_name === "string" && normalizedPayload.tool_name.length > 0
                      ? normalizedPayload.tool_name
                      : "unknown",
                  files: changedFiles
                }
              },
              {
                sourceRecordNamespace: "hook",
                sourceRecordId: normalizedPayload.tool_use_id.trim(),
                toolCallId: normalizeNativeId(normalizedPayload.tool_use_id) ?? undefined
              }
            )
          );
          await appendJsonLine(paths.eventLogPath, v2EditEvent);
        }
      }

      const transcriptPath = normalizeTranscriptPath(normalizedPayload.transcript_path, workspacePath);
      if (transcriptPath) {
        try {
          await recordClaudeTranscriptReference({
            manifestPath: paths.transcriptManifestPath,
            transcriptPath,
            workspacePath,
            sessionId:
              typeof normalizedPayload.session_id === "string" && normalizedPayload.session_id.length > 0
              ? normalizedPayload.session_id
              : undefined,
            lockTimeoutMs: 0
          });
          shouldSyncTranscripts = true;
        } catch {
          // Tool events should keep flowing even when transcript sync is busy.
        }

        if (!(await pathExists(transcriptPath))) {
          state.seenRawEventIds.push(envelope.raw_event_id);
          await saveParserStatePeriodically(paths.parserStatePath, state, processedLines);
          continue;
        }
      }

      state.seenRawEventIds.push(envelope.raw_event_id);
      await saveParserStatePeriodically(paths.parserStatePath, state, processedLines);
    }

    await saveParserState(paths.parserStatePath, state);

    if (shouldSyncTranscripts) {
      try {
        await syncKnownClaudeTranscripts({
          manifestPath: paths.transcriptManifestPath,
          eventLogPath: paths.eventLogPath,
          transcriptCursorPath: paths.transcriptCursorPath,
          transcriptLedgerPath: paths.transcriptLedgerPath,
          discoveryRoots: []
        });
      } catch {
        // Hook-derived tool metrics should keep flowing even when transcript sync fails transiently.
      }
    }
  });
}

async function saveParserStatePeriodically(
  parserStatePath: string,
  state: Awaited<ReturnType<typeof loadParserState>>,
  processedLines: number
): Promise<void> {
  if (processedLines % PARSER_STATE_FLUSH_INTERVAL !== 0) {
    return;
  }

  await saveParserState(parserStatePath, state);
}

function withFallbackTimestamp(payload: ClaudeHookPayload, timestamp: string): ClaudeHookPayload {
  if (typeof payload.timestamp === "string" && payload.timestamp.length > 0) {
    return payload;
  }

  return {
    ...payload,
    timestamp
  };
}

function normalizeTranscriptPath(
  transcriptPath: unknown,
  workspacePath: string
): string | undefined {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    return undefined;
  }

  return resolve(workspacePath, transcriptPath);
}

function normalizeWorkspacePath(cwd: unknown, repoRoot: string): string {
  return typeof cwd === "string" && cwd.length > 0 ? resolve(repoRoot, cwd) : repoRoot;
}

/**
 * Derives write-path V2 identity options for a Claude hook event. Prefers the
 * hook's own tool_use_id (trimmed, without the native: prefix) as the stable
 * identity so it lines up with normalizeClaudeHookEvent's tool_call_id;
 * falls back to the raw envelope id (stable once captured) for hook events
 * that carry no tool_use_id, such as SessionStart/SessionEnd.
 */
function buildHookNormalizationOptions(
  payload: ClaudeHookPayload,
  envelope: ClaudeRawEnvelope
): EventNormalizationOptions {
  const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id.trim() : "";

  if (toolUseId.length > 0) {
    return {
      sourceRecordNamespace: "hook",
      sourceRecordId: toolUseId,
      toolCallId: normalizeNativeId(toolUseId) ?? undefined
    };
  }

  return {
    sourceRecordNamespace: "hook",
    sourceRecordId: envelope.raw_event_id
  };
}

function withWorkspacePath(payload: ClaudeHookPayload, workspacePath: string): ClaudeHookPayload {
  if (payload.cwd === workspacePath) {
    return payload;
  }

  return {
    ...payload,
    cwd: workspacePath
  };
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  try {
    const contents = await readFile(filePath, "utf8");

    return contents
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => parseJsonLine(line));
  } catch {
    return [];
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
