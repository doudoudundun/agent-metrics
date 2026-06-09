import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_SEEN_RAW_EVENT_IDS = 2048;

export type ParserState = {
  nextLine: number;
  seenRawEventIds: string[];
};

export async function loadParserState(statePath: string): Promise<ParserState> {
  try {
    const contents = await readFile(statePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;

    if (!isRecord(parsed)) {
      return createEmptyParserState();
    }

    return {
      nextLine: normalizeNextLine(parsed.nextLine),
      seenRawEventIds: normalizeSeenRawEventIds(parsed.seenRawEventIds)
    };
  } catch {
    return createEmptyParserState();
  }
}

export async function saveParserState(statePath: string, state: ParserState): Promise<void> {
  const existingState = await loadParserState(statePath);
  const nextState = mergeParserState(existingState, state);

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(nextState, null, 2), "utf8");
}

function createEmptyParserState(): ParserState {
  return {
    nextLine: 0,
    seenRawEventIds: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNextLine(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeSeenRawEventIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value.filter((entry) => typeof entry === "string");
  if (normalized.length <= MAX_SEEN_RAW_EVENT_IDS) {
    return normalized;
  }

  return normalized.slice(-MAX_SEEN_RAW_EVENT_IDS);
}

function mergeParserState(existingState: ParserState, nextState: ParserState): ParserState {
  const mergedSeenRawEventIds = Array.from(
    new Set([...existingState.seenRawEventIds, ...nextState.seenRawEventIds])
  );

  return {
    nextLine: Math.max(existingState.nextLine, nextState.nextLine),
    seenRawEventIds:
      mergedSeenRawEventIds.length <= MAX_SEEN_RAW_EVENT_IDS
        ? mergedSeenRawEventIds
        : mergedSeenRawEventIds.slice(-MAX_SEEN_RAW_EVENT_IDS)
  };
}
