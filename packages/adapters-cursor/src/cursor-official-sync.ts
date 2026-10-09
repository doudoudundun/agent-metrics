import { hostname } from "node:os";
import { resolveDefaultCursorGlobalStorageDbPath } from "./cursor-sync.js";
import { readCursorAuthCredentials } from "./cursor-auth.js";
import { fetchCursorOfficialUsage, type CursorOfficialUsagePayload } from "./cursor-official-api.js";

export type CursorAccountUsageSnapshot = CursorOfficialUsagePayload & {
  sourceInstanceId: string;
  syncedAt: string;
};

export async function syncCursorOfficialUsage(input: {
  sourceInstanceId?: string;
  globalStorageDbPath?: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => Date;
  timeZone?: string;
} = {}): Promise<CursorAccountUsageSnapshot | null> {
  const globalStorageDbPath =
    input.globalStorageDbPath ??
    process.env.AGENT_METRICS_CURSOR_GLOBAL_STORAGE_DB_PATH ??
    resolveDefaultCursorGlobalStorageDbPath();

  const credentials = readCursorAuthCredentials(globalStorageDbPath);
  if (!credentials) {
    return null;
  }

  const result = await fetchCursorOfficialUsage({
    credentials,
    hostname: hostname(),
    fetchImpl: input.fetchImpl,
    apiBaseUrl: input.apiBaseUrl,
    now: input.now,
    timeZone: input.timeZone
  });

  if (!result.ok) {
    return null;
  }

  return {
    ...result.data,
    sourceInstanceId: input.sourceInstanceId ?? "cursor:default",
    syncedAt: (input.now ?? (() => new Date()))().toISOString()
  };
}
