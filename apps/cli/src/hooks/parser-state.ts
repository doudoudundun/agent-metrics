import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ParserState = {
  nextLine: number;
  seenRawEventIds: string[];
};

export async function loadParserState(statePath: string): Promise<ParserState> {
  try {
    const contents = await readFile(statePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;

    if (!isParserState(parsed)) {
      return createEmptyParserState();
    }

    return {
      nextLine: parsed.nextLine,
      seenRawEventIds: [...parsed.seenRawEventIds]
    };
  } catch {
    return createEmptyParserState();
  }
}

export async function saveParserState(statePath: string, state: ParserState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function createEmptyParserState(): ParserState {
  return {
    nextLine: 0,
    seenRawEventIds: []
  };
}

function isParserState(value: unknown): value is ParserState {
  return (
    typeof value === "object" &&
    value !== null &&
    "nextLine" in value &&
    typeof value.nextLine === "number" &&
    Number.isInteger(value.nextLine) &&
    value.nextLine >= 0 &&
    "seenRawEventIds" in value &&
    Array.isArray(value.seenRawEventIds) &&
    value.seenRawEventIds.every((entry) => typeof entry === "string")
  );
}
