import { homedir } from "node:os";
import { join } from "node:path";
import { syncOpenCodeFamilyDatabase } from "@agent-metrics/adapters-opencode";
import type { SourceAdapter, SourceVendor } from "@agent-metrics/event-schema";

const MIMO_SOURCE_VENDOR: SourceVendor = "mimo";
const MIMO_SOURCE_ADAPTER: SourceAdapter = "mimo-db";
const MIMO_SOURCE_KEY = "mimo";
const MIMO_EVENT_NAMESPACE = "mimo";
/**
 * The sync ledger is keyed on the pre-V2 legacy event ids that the shared
 * OpenCode-schema builder emits, so the prefix must match its `opencode:<ns>:`
 * shape rather than the vendor name.
 */
const MIMO_LEDGER_PREFIX = `opencode:${MIMO_EVENT_NAMESPACE}:`;

export function resolveDefaultMiMoDbPath(): string {
  return join(homedir(), ".local", "share", "mimocode", "mimocode.db");
}

export function resolveDefaultMiMoModelsPath(): string {
  return join(homedir(), ".cache", "mimocode", "models.json");
}

export function resolveMiMoSourcePaths(input: { dbPath?: string; modelsPath?: string } = {}): {
  dbPath: string;
  modelsPath: string;
} {
  return {
    dbPath:
      input.dbPath ??
      process.env.AGENT_METRICS_MIMO_DB_PATH ??
      resolveDefaultMiMoDbPath(),
    modelsPath:
      input.modelsPath ??
      process.env.AGENT_METRICS_MIMO_MODELS_PATH ??
      resolveDefaultMiMoModelsPath()
  };
}

/**
 * MiMo Desktop keeps its trajectory in an OpenCode-schema SQLite database
 * (`session` / `message` / `part`), so token counts, tool calls, and prompts are
 * read through the shared OpenCode-family pipeline. Only the vendor/adapter
 * identity and the source paths differ.
 */
export async function syncMiMoDatabase(input: {
  eventLogPath: string;
  cursorPath: string;
  ledgerPath: string;
  dbPath?: string;
  modelsPath?: string;
}): Promise<void> {
  const { dbPath, modelsPath } = resolveMiMoSourcePaths(input);
  await syncOpenCodeFamilyDatabase({
    eventLogPath: input.eventLogPath,
    cursorPath: input.cursorPath,
    ledgerPath: input.ledgerPath,
    ledgerPrefix: MIMO_LEDGER_PREFIX,
    sources: [
      {
        key: MIMO_SOURCE_KEY,
        dbPath,
        modelsPath,
        eventNamespace: MIMO_EVENT_NAMESPACE,
        sourceAdapter: MIMO_SOURCE_ADAPTER,
        sourceVendor: MIMO_SOURCE_VENDOR
      }
    ]
  });
}
