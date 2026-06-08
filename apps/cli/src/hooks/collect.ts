import { resolve } from "node:path";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import type { Command } from "commander";
import {
  buildClaudeRawEnvelope,
  extractMutationTargets,
  recordClaudeTranscriptReference,
  type ClaudeHookPayload
} from "@agent-metrics/adapters-claude";
import { captureBeforeSnapshots, discardSnapshots } from "./snapshots.js";
import { getHookPaths } from "./paths.js";

export function registerCollectCommand(hooks: Command): void {
  hooks
    .command("collect")
    .description("Read a Claude hook payload from stdin and write agent-metrics events.")
    .option("--repo-root <path>", "Path to the agent-metrics repository root.", process.cwd())
    .option(
      "--hook-event-name <name>",
      "Hook event name to backfill when stdin JSON omits it."
    )
    .action(async (options: { repoRoot: string; hookEventName?: string }) => {
      await collectHookFromStdin({
        repoRoot: options.repoRoot,
        hookEventName: options.hookEventName
      });
    });
}

export async function collectHookFromStdin(input: {
  repoRoot: string;
  hookEventName?: string;
  stdin?: NodeJS.ReadableStream;
}): Promise<void> {
  const payload = await readHookPayloadFromStdin({
    stdin: input.stdin,
    hookEventName: input.hookEventName
  });

  if (payload === null) {
    return;
  }

  await handleHookEvent({
    repoRoot: resolve(input.repoRoot),
    payload
  });
}

export async function readHookPayloadFromStdin(input: {
  stdin?: NodeJS.ReadableStream;
  hookEventName?: string;
}): Promise<ClaudeHookPayload | null> {
  const stdinText = await readStdinText(input.stdin ?? process.stdin);

  return buildHookPayloadFromInput({
    stdinText,
    hookEventName: input.hookEventName
  });
}

export function buildHookPayloadFromInput(input: {
  stdinText: string;
  hookEventName?: string;
}): ClaudeHookPayload | null {
  const parsed = parseJsonObject(input.stdinText);

  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    return null;
  }

  const payload = parsed as ClaudeHookPayload;

  if (typeof input.hookEventName !== "string" || input.hookEventName.length === 0) {
    return payload;
  }

  if (typeof payload.hook_event_name === "string" && payload.hook_event_name.length > 0) {
    return payload;
  }

  return {
    ...payload,
    hook_event_name: input.hookEventName
  };
}

export async function handleHookEvent(input: {
  repoRoot: string;
  payload: ClaudeHookPayload;
}): Promise<void> {
  const paths = getHookPaths(input.repoRoot);
  const workspacePath = normalizeWorkspacePath(input.payload.cwd, input.repoRoot);
  const normalizedPayload = withWorkspacePath(input.payload, workspacePath);

  await appendJsonLine(paths.rawHookLogPath, buildClaudeRawEnvelope(normalizedPayload));

  const transcriptPath = normalizeTranscriptPath(normalizedPayload.transcript_path, workspacePath);
  if (transcriptPath) {
    try {
      await recordClaudeTranscriptReference({
        manifestPath: paths.transcriptManifestPath,
        transcriptPath,
        workspacePath,
        sessionId: normalizeOptionalString(normalizedPayload.session_id),
        lockTimeoutMs: 0
      });
    } catch {
      // Raw hooks are the source of truth; parser replay can recover transcript metadata later.
    }
  }

  if (normalizedPayload.hook_event_name === "PreToolUse") {
    await maybeCaptureBeforeSnapshots({
      payload: normalizedPayload,
      snapshotRoot: paths.snapshotRoot,
      workspacePath
    });
  }

  if (normalizedPayload.hook_event_name === "PostToolUseFailure") {
    await discardSnapshots({
      snapshotRoot: paths.snapshotRoot,
      toolUseId: normalizedPayload.tool_use_id
    });
  }
}

async function maybeCaptureBeforeSnapshots(input: {
  payload: ClaudeHookPayload;
  snapshotRoot: string;
  workspacePath: string;
}): Promise<void> {
  if (typeof input.payload.tool_use_id !== "string" || input.payload.tool_use_id.length === 0) {
    return;
  }

  const targets = extractMutationTargets({
    toolName: input.payload.tool_name,
    toolInput: input.payload.tool_input
  });

  if (targets.length === 0) {
    return;
  }

  await captureBeforeSnapshots({
    snapshotRoot: input.snapshotRoot,
    toolUseId: input.payload.tool_use_id,
    workspacePath: input.workspacePath,
    targets
  });
}

function normalizeWorkspacePath(cwd: unknown, repoRoot: string): string {
  return typeof cwd === "string" && cwd.length > 0 ? resolve(repoRoot, cwd) : repoRoot;
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

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

async function readStdinText(stdin: NodeJS.ReadableStream): Promise<string> {
  if (isTty(stdin)) {
    return "";
  }

  if ("setEncoding" in stdin && typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }

  return await new Promise<string>((resolvePromise, reject) => {
    let text = "";

    stdin.on("data", (chunk) => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    stdin.on("end", () => resolvePromise(text));
    stdin.on("error", reject);

    if ("resume" in stdin && typeof stdin.resume === "function") {
      stdin.resume();
    }
  });
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTty(stream: NodeJS.ReadableStream): stream is NodeJS.ReadStream & { isTTY: true } {
  return "isTTY" in stream && stream.isTTY === true;
}
