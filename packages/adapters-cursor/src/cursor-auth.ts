import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  "cursorAuth/cachedScopedProfile",
  "cursorAuth/stripeMembershipType",
  "cursorAuth/stripeSubscriptionStatus",
  "storage.serviceMachineId"
] as const;

const SAFE_STORAGE_PREFIX = "cursor-safe-storage:";

function defaultCursorCliAuthPath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "auth.json");
}

function readMatchingCliAccessToken(authPath: string, scopedProfile: string): string | null {
  try {
    const profile = JSON.parse(scopedProfile) as { authId?: unknown } | null;
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as { accessToken?: unknown } | null;
    if (typeof profile?.authId !== "string" || !profile.authId || typeof auth?.accessToken !== "string") {
      return null;
    }

    const parts = auth.accessToken.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) {
      return null;
    }
    // The subject selects the same account. Cursor still validates the token on each request.
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown } | null;
    return claims?.sub === profile.authId ? auth.accessToken : null;
  } catch {
    return null;
  }
}

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
  globalStorageDbPath: string = resolveDefaultCursorGlobalStorageDbPath(),
  cliAuthPath: string | undefined = defaultCursorCliAuthPath()
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

    const storedAccessToken = values.get("cursorAuth/accessToken");
    if (!storedAccessToken) {
      return null;
    }

    const isEncrypted = storedAccessToken.startsWith(SAFE_STORAGE_PREFIX);
    const scopedProfile = values.get("cursorAuth/cachedScopedProfile");
    const accessToken = isEncrypted
      ? cliAuthPath && scopedProfile && readMatchingCliAccessToken(cliAuthPath, scopedProfile)
      : storedAccessToken;
    if (!accessToken) {
      return null;
    }

    const refreshToken = values.get("cursorAuth/refreshToken");
    return {
      accessToken,
      // Leave CLI session refresh to the CLI. Never send IDE Safe Storage values as tokens.
      refreshToken: isEncrypted || refreshToken?.startsWith(SAFE_STORAGE_PREFIX) ? null : refreshToken ?? null,
      email: values.get("cursorAuth/cachedEmail") ?? null,
      planTier: values.get("cursorAuth/stripeMembershipType") ?? null,
      subscriptionStatus: values.get("cursorAuth/stripeSubscriptionStatus") ?? null,
      machineId: values.get("storage.serviceMachineId") ?? null
    };
  } finally {
    db.close();
  }
}
