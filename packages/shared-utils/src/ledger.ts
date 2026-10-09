import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

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
 * Rebuild the event ledger by scanning an event log file and collecting stable
 * ledger keys that match the given prefix. This is used as a fallback when the
 * ledger file is missing or corrupted.
 *
 * After schema version 2 migration, domain event logs store `event_id` as
 * `v2:...` while the sync ledger still keys on the pre-conversion stable id
 * written to `source_record_id`. Prefer that field when present so a lost
 * ledger can be rebuilt without re-emitting every V2 row.
 */
export async function rebuildEventLedgerFromLog(
  eventLogPath: string,
  prefix: string
): Promise<Set<string>> {
  const eventIds = new Set<string>();

  try {
    for await (const key of readLedgerKeys(eventLogPath)) {
      if (key.startsWith(prefix)) {
        eventIds.add(key);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

/**
 * For a set of session IDs, make in-memory ledger keys match the event log:
 * drop keys that are not actually present (ghosts), and add keys found in the log.
 *
 * Used by adapters to recover from "ledger says seen, jsonl never got the row"
 * without rebuilding the entire ledger on every sync.
 */
export async function reconcileLedgerSessionsWithEventLog(input: {
  eventLogPath: string;
  prefix: string;
  seenEventIds: Set<string>;
  sessionIds: Set<string>;
  sessionIdFromKey: (ledgerKey: string) => string | null;
}): Promise<{ removed: number; added: number }> {
  if (input.sessionIds.size === 0) {
    return { removed: 0, added: 0 };
  }

  const logKeys = await collectLedgerKeysFromEventLogForSessions(input);

  let removed = 0;
  for (const key of [...input.seenEventIds]) {
    const sessionId = input.sessionIdFromKey(key);
    if (
      sessionId !== null &&
      input.sessionIds.has(sessionId) &&
      !logKeys.has(key)
    ) {
      input.seenEventIds.delete(key);
      removed += 1;
    }
  }

  let added = 0;
  for (const key of logKeys) {
    if (!input.seenEventIds.has(key)) {
      input.seenEventIds.add(key);
      added += 1;
    }
  }

  return { removed, added };
}

async function collectLedgerKeysFromEventLogForSessions(input: {
  eventLogPath: string;
  prefix: string;
  sessionIds: Set<string>;
  sessionIdFromKey: (ledgerKey: string) => string | null;
}): Promise<Set<string>> {
  const eventIds = new Set<string>();

  // Complete the read before changing the caller's ledger. An unreadable log
  // provides no evidence that existing keys are ghosts.
  for await (const key of readLedgerKeys(input.eventLogPath)) {
    if (!key.startsWith(input.prefix)) continue;
    const sessionId = input.sessionIdFromKey(key);
    if (sessionId !== null && input.sessionIds.has(sessionId)) {
      eventIds.add(key);
    }
  }
  return eventIds;
}

async function* readLedgerKeys(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const record = parsed as {
        event_id?: unknown;
        source_record_id?: unknown;
      };
      const ledgerKey =
        typeof record.source_record_id === "string" && record.source_record_id.length > 0
          ? record.source_record_id
          : typeof record.event_id === "string"
            ? record.event_id
            : null;

      if (ledgerKey !== null) yield ledgerKey;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
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
