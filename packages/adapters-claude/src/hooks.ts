import { randomUUID } from "node:crypto";
import type { AnyEvent } from "@agent-metrics/event-schema";

type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure";

export type ClaudeHookPayload = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  transcript_path?: string;
  duration_ms?: number;
  exit_code?: number | null;
  timestamp?: string;
};

export type ClaudeRawEnvelope = {
  raw_event_id: string;
  captured_at: string;
  hook_event_name: string;
  session_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  workspace_path?: string;
  transcript_path?: string;
  payload: ClaudeHookPayload;
};

export function buildClaudeRawEnvelope(payload: ClaudeHookPayload): ClaudeRawEnvelope {
  return {
    raw_event_id: randomUUID(),
    captured_at: new Date().toISOString(),
    hook_event_name: normalizeString(payload.hook_event_name, "unknown"),
    session_id: normalizeOptionalString(payload.session_id),
    tool_use_id: normalizeOptionalString(payload.tool_use_id),
    tool_name: normalizeOptionalString(payload.tool_name),
    workspace_path: normalizeOptionalString(payload.cwd),
    transcript_path: normalizeOptionalString(payload.transcript_path),
    payload
  };
}

export function normalizeClaudeHookEvent(payload: ClaudeHookPayload): AnyEvent | null {
  const eventName = payload.hook_event_name as HookEventName | undefined;
  const base = {
    event_id: randomUUID(),
    session_id: normalizeString(payload.session_id, "unknown-session"),
    timestamp: normalizeTimestamp(payload.timestamp),
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: normalizeString(payload.cwd, ".")
  };

  if (eventName === "SessionStart") {
    return {
      ...base,
      type: "session.started"
    };
  }

  if (eventName === "SessionEnd") {
    return {
      ...base,
      type: "session.ended",
      exit_code: normalizeOptionalInteger(payload.exit_code),
      duration_ms: normalizeDuration(payload.duration_ms)
    };
  }

  if (eventName === "PreToolUse") {
    return {
      ...base,
      type: "tool.called",
      tool_name: normalizeString(payload.tool_name, "unknown"),
      status: "started",
      argument_summary: summarizeToolInput(payload.tool_input)
    };
  }

  if (eventName === "PostToolUse") {
    return {
      ...base,
      type: "tool.succeeded",
      tool_name: normalizeString(payload.tool_name, "unknown"),
      status: "succeeded",
      duration_ms: normalizeDuration(payload.duration_ms)
    };
  }

  if (eventName === "PostToolUseFailure") {
    return {
      ...base,
      type: "tool.failed",
      tool_name: normalizeString(payload.tool_name, "unknown"),
      status: "failed",
      duration_ms: normalizeDuration(payload.duration_ms)
    };
  }

  return null;
}

export function extractMutationTargets(input: {
  toolName?: string;
  toolInput?: unknown;
}): string[] {
  if (input.toolName === "Write" || input.toolName === "Edit" || input.toolName === "MultiEdit") {
    const toolInput = isRecord(input.toolInput) ? input.toolInput : null;
    const filePath = toolInput?.file_path;

    if (typeof filePath !== "string" || filePath.length === 0) {
      return [];
    }

    return [filePath];
  }

  if (input.toolName === "Bash") {
    return extractBashMutationTargets(input.toolInput);
  }

  return [];
}

function extractBashMutationTargets(toolInput: unknown): string[] {
  const inputRecord = isRecord(toolInput) ? toolInput : null;
  const command = inputRecord?.command;

  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }

  return extractMutationTargetsFromCommand(command, 0);
}

function extractMutationTargetsFromCommand(command: string, depth: number): string[] {
  if (depth > 1) {
    return [];
  }

  const tokens = tokenizeShellCommand(command);

  if (tokens.length === 0) {
    return [];
  }

  const wrappedTargets = extractWrappedShellTargets(tokens, depth);
  if (wrappedTargets.length > 0) {
    return wrappedTargets;
  }

  const rmTargets = extractRmTargets(tokens);
  if (rmTargets.length > 0) {
    return rmTargets;
  }

  const sedTargets = extractSedTargets(tokens);
  if (sedTargets.length > 0) {
    return sedTargets;
  }

  return [];
}

function extractWrappedShellTargets(tokens: string[], depth: number): string[] {
  if (
    (tokens[0] !== "bash" && tokens[0] !== "sh" && tokens[0] !== "zsh") ||
    (tokens[1] !== "-c" && tokens[1] !== "-lc") ||
    typeof tokens[2] !== "string"
  ) {
    return [];
  }

  return extractMutationTargetsFromCommand(tokens[2], depth + 1);
}

function extractRmTargets(tokens: string[]): string[] {
  if (tokens[0] !== "rm") {
    return [];
  }

  const targets: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (isCommandSeparator(token)) {
      break;
    }

    if (token === "--") {
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      continue;
    }

    const path = normalizePathToken(token);
    if (path !== null) {
      targets.push(path);
    }
  }

  return dedupePaths(targets);
}

function extractSedTargets(tokens: string[]): string[] {
  if (tokens[0] !== "sed") {
    return [];
  }

  let sawInPlace = false;
  let sawScript = false;
  let expectingExpression = false;
  let expectingScriptFile = false;
  const targets: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (isCommandSeparator(token)) {
      break;
    }

    if (expectingExpression) {
      expectingExpression = false;
      sawScript = true;
      continue;
    }

    if (expectingScriptFile) {
      expectingScriptFile = false;
      continue;
    }

    if (!sawScript) {
      if (isSedInPlaceOption(token)) {
        sawInPlace = true;
        continue;
      }

      if (token === "-e" || token === "--expression") {
        expectingExpression = true;
        continue;
      }

      if (token === "-f" || token === "--file") {
        expectingScriptFile = true;
        continue;
      }

      if (token.startsWith("-")) {
        continue;
      }

      sawScript = true;
      continue;
    }

    const path = normalizePathToken(token);
    if (path !== null) {
      targets.push(path);
    }
  }

  if (!sawInPlace) {
    return [];
  }

  return dedupePaths(targets);
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let active = false;
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaping) {
      current += character;
      active = true;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }

      continue;
    }

    if (quote === "\"") {
      if (character === "\"") {
        quote = null;
        continue;
      }

      if (character === "\\") {
        escaping = true;
        active = true;
        continue;
      }

      current += character;
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      active = true;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      active = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (active) {
        tokens.push(current);
        current = "";
        active = false;
      }

      continue;
    }

    const operator = readShellOperator(command, index);
    if (operator !== null) {
      if (active) {
        tokens.push(current);
        current = "";
        active = false;
      }

      tokens.push(operator.value);
      index = operator.nextIndex;
      continue;
    }

    current += character;
    active = true;
  }

  if (escaping) {
    current += "\\";
  }

  if (active) {
    tokens.push(current);
  }

  return tokens;
}

function readShellOperator(
  command: string,
  index: number
): { value: string; nextIndex: number } | null {
  const character = command[index];
  const nextCharacter = command[index + 1];

  if (
    (character === "&" && nextCharacter === "&") ||
    (character === "|" && nextCharacter === "|") ||
    (character === ">" && nextCharacter === ">") ||
    (character === "<" && nextCharacter === "<")
  ) {
    return {
      value: `${character}${nextCharacter}`,
      nextIndex: index + 1
    };
  }

  if ("&|;><()".includes(character)) {
    return {
      value: character,
      nextIndex: index
    };
  }

  return null;
}

function isSedInPlaceOption(token: string): boolean {
  return token === "-i" || token.startsWith("-i") || token === "--in-place" || token.startsWith("--in-place=");
}

function normalizePathToken(token: string): string | null {
  if (token.length === 0) {
    return null;
  }

  if (/[*?$`]/.test(token) || /[><|&;()]/.test(token) || token.startsWith("~")) {
    return null;
  }

  return token;
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isCommandSeparator(token: string): boolean {
  return token === "&&" || token === "||" || token === ";" || token === "|";
}

function summarizeToolInput(toolInput: unknown): string {
  if (toolInput === undefined) {
    return "";
  }

  if (typeof toolInput === "string") {
    return toolInput;
  }

  try {
    return JSON.stringify(toolInput);
  } catch {
    return "";
  }
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDuration(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  return 0;
}

function normalizeOptionalInteger(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  return undefined;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string" && isIsoLikeTimestamp(value)) {
    const parsed = new Date(value);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIsoLikeTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}
