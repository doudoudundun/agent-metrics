import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveDefaultCursorGlobalStorageDbPath } from "./cursor-sync.js";

type ReadOnlyDatabase = {
  close(): void;
  prepare<Result = unknown>(sql: string): {
    get(...params: unknown[]): Result | undefined;
  };
};

export type CursorAuthCredentials = {
  accessToken: string;
  refreshToken: string | null;
  email: string | null;
  planTier: string | null;
  subscriptionStatus: string | null;
  machineId: string | null;
};

const AUTH_KEYS = [
  "cursorAuth/accessToken",
  "cursorAuth/refreshToken",
  "cursorAuth/cachedEmail",
  "cursorAuth/stripeMembershipType",
  "cursorAuth/stripeSubscriptionStatus",
  "storage.serviceMachineId"
] as const;

function unwrapStoredString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
    } catch {
      return value;
    }
  }

  return value;
}

export function readCursorAuthCredentials(
  globalStorageDbPath: string = resolveDefaultCursorGlobalStorageDbPath()
): CursorAuthCredentials | null {
  if (!existsSync(globalStorageDbPath)) {
    return null;
  }

  const db = new Database(globalStorageDbPath, { readonly: true, fileMustExist: true }) as ReadOnlyDatabase;

  try {
    const values = new Map<string, string | null>();

    for (const key of AUTH_KEYS) {
      const row = db
        .prepare<{ value: string | null }>("SELECT value FROM ItemTable WHERE key = ?")
        .get(key);
      values.set(key, unwrapStoredString(row?.value ?? null));
    }

    const accessToken = values.get("cursorAuth/accessToken");
    if (!accessToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken: values.get("cursorAuth/refreshToken") ?? null,
      email: values.get("cursorAuth/cachedEmail") ?? null,
      planTier: values.get("cursorAuth/stripeMembershipType") ?? null,
      subscriptionStatus: values.get("cursorAuth/stripeSubscriptionStatus") ?? null,
      machineId: values.get("storage.serviceMachineId") ?? null
    };
  } finally {
    db.close();
  }
}
