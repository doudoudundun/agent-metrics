import { readFile } from "node:fs/promises";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import {
  normalizeClaudeHookEvent,
  normalizeClaudeObservation,
  type ClaudeHookPayload
} from "@agent-metrics/adapters-claude";
import { getHookPaths } from "./paths.js";
import { loadParserState, saveParserState } from "./parser-state.js";
import { parseClaudeRawEnvelope } from "./raw-envelope.js";
import { collectChangedSnapshots } from "./snapshots.js";

export async function parseRawHooksOnce(input: { repoRoot: string }): Promise<void> {
  const paths = getHookPaths(input.repoRoot);
  const state = await loadParserState(paths.parserStatePath);
  const rawLines = await readJsonLines(paths.rawHookLogPath);
  const pendingLines = rawLines.slice(state.nextLine);

  for (const line of pendingLines) {
    state.nextLine += 1;

    const envelope = parseClaudeRawEnvelope(line);
    if (envelope === null || state.seenRawEventIds.includes(envelope.raw_event_id)) {
      continue;
    }

    const payload = withFallbackTimestamp(envelope.payload, envelope.captured_at);
    const normalizedEvent = normalizeClaudeHookEvent(payload);

    if (normalizedEvent !== null) {
      await appendJsonLine(paths.eventLogPath, normalizedEvent);
    }

    if (payload.hook_event_name === "PostToolUse") {
      const changedFiles = await collectChangedSnapshots({
        snapshotRoot: paths.snapshotRoot,
        toolUseId: payload.tool_use_id
      });

      if (changedFiles.length > 0) {
        await appendJsonLine(
          paths.eventLogPath,
          normalizeClaudeObservation({
            sessionId:
              typeof payload.session_id === "string" && payload.session_id.length > 0
                ? payload.session_id
                : "unknown-session",
            workspacePath:
              typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : input.repoRoot,
            observation: {
              kind: "edit_applied",
              toolName:
                typeof payload.tool_name === "string" && payload.tool_name.length > 0
                  ? payload.tool_name
                  : "unknown",
              files: changedFiles
            }
          })
        );
      }
    }

    state.seenRawEventIds.push(envelope.raw_event_id);
  }

  await saveParserState(paths.parserStatePath, state);
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

async function readJsonLines(filePath: string): Promise<unknown[]> {
  try {
    const contents = await readFile(filePath, "utf8");

    return contents
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}
