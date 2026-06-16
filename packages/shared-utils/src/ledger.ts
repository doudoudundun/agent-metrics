import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type EventLedger = {
  eventIds: string[];
};

/**
 * Load the event ledger from a JSON file. Returns an empty Set if the ledger
 * is missing, malformed, or contains no valid event IDs.
 */
export async function loadEventLedger(ledgerPath: string): Promise<Set<string>> {
  let contents: string;
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch {
    return new Set<string>();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return new Set<string>();
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("eventIds" in parsed) ||
    !Array.isArray(parsed.eventIds)
  ) {
    return new Set<string>();
  }

  return new Set(
    parsed.eventIds.filter((entry): entry is string => typeof entry === "string")
  );
}

/**
 * Rebuild the event ledger by scanning an event log file and collecting all
 * event IDs that match the given prefix. This is used as a fallback when the
 * ledger file is missing or corrupted.
 */
export async function rebuildEventLedgerFromLog(
  eventLogPath: string,
  prefix: string
): Promise<Set<string>> {
  const eventIds = new Set<string>();

  let contents: string;
  try {
    contents = await readFile(eventLogPath, "utf8");
  } catch {
    return eventIds;
  }

  for (const line of contents.split("\n").filter((entry) => entry.length > 0)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "event_id" in parsed &&
      typeof parsed.event_id === "string" &&
      parsed.event_id.startsWith(prefix)
    ) {
      eventIds.add(parsed.event_id);
    }
  }

  return eventIds;
}

/**
 * Persist the event ledger to a JSON file with atomic write semantics.
 */
export async function persistEventLedger(
  ledgerPath: string,
  eventIds: Set<string>
): Promise<void> {
  const sortedIds = [...eventIds].sort();
  const value: EventLedger = { eventIds: sortedIds };
  await writeJsonFileAtomic(ledgerPath, value);
}

/**
 * Load event IDs from the ledger file, with fallback to rebuilding from the
 * event log when the ledger is missing or empty. If fallback occurs, the
 * rebuilt ledger is persisted before returning.
 *
 * This pattern avoids O(n) event log scans on every sync when the ledger
 * is present, while still recovering gracefully when it's lost.
 */
export async function loadEventLedgerWithFallback(input: {
  ledgerPath: string;
  eventLogPath: string;
  prefix: string;
}): Promise<Set<string>> {
  const ledgerIds = await loadEventLedger(input.ledgerPath);

  // Normal case: ledger exists and has entries. No scan needed.
  if (ledgerIds.size > 0) {
    return ledgerIds;
  }

  // Fallback: rebuild from event log and persist for future runs.
  const rebuiltIds = await rebuildEventLedgerFromLog(
    input.eventLogPath,
    input.prefix
  );

  if (rebuiltIds.size > 0) {
    await persistEventLedger(input.ledgerPath, rebuiltIds);
  }

  return rebuiltIds;
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");

  try {
    await rename(tempPath, filePath);
  } catch {
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  }
}