import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import {
  normalizeClaudeHookEvent,
  normalizeClaudeObservation,
  recordClaudeTranscriptReference,
  syncKnownClaudeTranscripts,
  type ClaudeHookPayload
} from "@agent-metrics/adapters-claude";
import { getHookPaths } from "./paths.js";
import { loadParserState, saveParserState } from "./parser-state.js";
import { parseClaudeRawEnvelope } from "./raw-envelope.js";
import { collectChangedSnapshots } from "./snapshots.js";

const PARSER_STATE_FLUSH_INTERVAL = 100;

export async function parseRawHooksOnce(input: { repoRoot: string }): Promise<void> {
  const paths = getHookPaths(input.repoRoot);
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
    const normalizedEvent = normalizeClaudeHookEvent(normalizedPayload);

    if (normalizedEvent !== null) {
      await appendJsonLine(paths.eventLogPath, normalizedEvent);
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
        await appendJsonLine(
          paths.eventLogPath,
          normalizeClaudeObservation({
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
          })
        );
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
    await syncKnownClaudeTranscripts({
      manifestPath: paths.transcriptManifestPath,
      eventLogPath: paths.eventLogPath,
      transcriptCursorPath: paths.transcriptCursorPath,
      transcriptLedgerPath: paths.transcriptLedgerPath,
      discoveryRoots: []
    });
  }
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
