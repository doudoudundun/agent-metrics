import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  asRecord,
  normalizeEpochMs,
  parseJsonRecord,
  readFiniteNumber,
  readNonEmptyString,
  readTimestamp
} from "./official-key-usage-antigravity-values.js";

const ACP_DIR_NAME = "antigravity-acp";
const ACP_TOKEN_FILE = "acp_token.json";
const CLI_TOKEN_FILE = "antigravity-oauth-token";
const MANAGER_ACCOUNTS_INDEX_FILE = "accounts.json";
const MANAGER_ACCOUNTS_DIR = "accounts";
const AUTH_STATE_REL_PATH = join("cache", "acp-auth-state.json");
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";
const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";
const GO_KEYRING_HEX_PREFIX = "go-keyring-encoded:";
export const EXPIRES_SKEW_MS = 60 * 1000;
const KEYRING_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

export type AntigravityAuthMethod = "oauth-personal" | "oauth-business";

export type AntigravityCredentials =
  | {
      kind: "acp-token";
      authMethod: AntigravityAuthMethod;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      projectId: string | null;
    }
  | {
      kind: "cli-token";
      authMethod: AntigravityAuthMethod;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: number | null;
      clientId: string | null;
      clientSecret: string | null;
      projectId: string | null;
    };

export type AntigravityCredentialOptions = {
  providersRoot?: string;
  cliHome?: string;
  managerRoot?: string;
  readKeyringSecret?: () => Promise<string | null>;
  now?: () => Date;
};

type ManagerAccount = {
  source: "manager";
  credentials: AntigravityCredentials | null;
  quota: Record<string, unknown> | null;
};

type LocalAccount = {
  source: "local";
  credentials: AntigravityCredentials | null;
};

/**
 * Decodes a secret stored by `go-keyring` (`go-keyring-base64:...` or
 * `go-keyring-encoded:...` hex) or returns plain text as-is.
 */
export function decodeGoKeyringSecret(rawSecret: string): string {
  const trimmed = rawSecret.trim();
  if (trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    return Buffer.from(trimmed.slice(GO_KEYRING_BASE64_PREFIX.length), "base64").toString("utf8");
  }
  if (trimmed.startsWith(GO_KEYRING_HEX_PREFIX)) {
    return Buffer.from(trimmed.slice(GO_KEYRING_HEX_PREFIX.length), "hex").toString("utf8");
  }
  return trimmed;
}

/**
 * Reads local Antigravity credentials (from Antigravity Manager, profile files
 * under `providersRoot`, standalone `cliHome`, or the OS keyring when no
 * source-isolation override is active). Returns null when no usable credentials
 * are present.
 */
export async function readAntigravityCredentials(
  options: AntigravityCredentialOptions = {}
): Promise<AntigravityCredentials | null> {
  return (await readAntigravityAccount(options)).credentials;
}

export async function readAntigravityAccount(
  options: AntigravityCredentialOptions
): Promise<ManagerAccount | LocalAccount> {
  const paths = resolveCredentialRoots(options);
  if (paths.managerRoot !== null) {
    const account = readAntigravityManagerAccount(paths.managerRoot, paths.providersRoot);
    if (account !== null) {
      return account;
    }
  }
  return { source: "local", credentials: await readLocalCredentials(paths, options) };
}

async function readLocalCredentials(
  paths: ReturnType<typeof resolveCredentialRoots>,
  options: AntigravityCredentialOptions
): Promise<AntigravityCredentials | null> {
  const nowMs = options.now?.().getTime() ?? Date.now();
  const profileCredentials = readProfileCredentials(paths.providersRoot, nowMs);
  if (profileCredentials !== null) {
    return profileCredentials;
  }

  if (paths.cliHome !== null) {
    const cliTokenPath = join(paths.cliHome, CLI_TOKEN_FILE);
    if (existsSync(cliTokenPath)) {
      const raw = readFileUtf8(cliTokenPath);
      const authMethod =
        readAuthMethod(join(paths.cliHome, AUTH_STATE_REL_PATH)) ?? "oauth-personal";
      const parsed = raw === null ? null : parseCliTokenCredentials(raw, authMethod);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  if (!paths.allowSystemKeyring) {
    return null;
  }

  const rawSecret = await (options.readKeyringSecret ?? readSystemKeyringSecret)();
  if (rawSecret === null) {
    return null;
  }

  const decoded = decodeGoKeyringSecret(rawSecret);
  const authMethod = resolveProfileAuthMethod(paths.providersRoot) ?? "oauth-personal";
  return parseCliTokenCredentials(decoded, authMethod);
}

export function canRefreshCredentials(credentials: AntigravityCredentials): boolean {
  if (credentials.kind === "acp-token") {
    return true;
  }
  return (
    credentials.clientId !== null &&
    credentials.clientSecret !== null &&
    credentials.refreshToken !== null
  );
}

function resolveCredentialRoots(options: AntigravityCredentialOptions): {
  providersRoot: string;
  cliHome: string | null;
  managerRoot: string | null;
  allowSystemKeyring: boolean;
} {
  const providersRoot = options.providersRoot ?? resolveDefaultProvidersRoot();
  const allowDefaultLocalFallback =
    options.providersRoot === undefined &&
    readNonEmptyString(process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT) === null;
  const envCliHome = readNonEmptyString(process.env.AGENT_METRICS_ANTIGRAVITY_CLI_HOME);
  const cliHome =
    options.cliHome ??
    envCliHome ??
    (allowDefaultLocalFallback ? resolveDefaultCliHome() : null);
  const managerRoot =
    options.managerRoot ??
    readNonEmptyString(process.env.AGENT_METRICS_ANTIGRAVITY_MANAGER_ROOT) ??
    (allowDefaultLocalFallback && options.cliHome === undefined && envCliHome === null
      ? resolveDefaultManagerRoot()
      : null);
  const allowSystemKeyring =
    options.readKeyringSecret !== undefined ||
    (allowDefaultLocalFallback && options.cliHome === undefined && envCliHome === null);
  return { providersRoot, cliHome, managerRoot, allowSystemKeyring };
}

function readAntigravityManagerAccount(
  managerRoot: string,
  providersRoot: string
): ManagerAccount | null {
  const indexPath = join(managerRoot, MANAGER_ACCOUNTS_INDEX_FILE);
  if (!existsSync(indexPath)) {
    return null;
  }

  const indexRaw = readFileUtf8(indexPath);
  const index = indexRaw === null ? null : parseJsonRecord(indexRaw);
  if (index === null) {
    return null;
  }

  const targetIde = readNonEmptyString(index.current_target_ide);
  const candidateIds =
    targetIde === "classic"
      ? [
          index.current_classic_account_id,
          index.current_account_id,
          index.current_agy_account_id
        ]
      : [
          index.current_agy_account_id,
          index.current_account_id,
          index.current_classic_account_id
        ];

  for (const rawId of candidateIds) {
    const accountId = readNonEmptyString(rawId);
    if (
      accountId === null ||
      accountId === "." ||
      accountId === ".." ||
      /[/\\]/u.test(accountId)
    ) {
      continue;
    }

    const detailPath = join(managerRoot, MANAGER_ACCOUNTS_DIR, `${accountId}.json`);
    if (!existsSync(detailPath)) {
      continue;
    }

    const detailRaw = readFileUtf8(detailPath);
    const detail = detailRaw === null ? null : parseJsonRecord(detailRaw);
    if (detail === null) {
      continue;
    }

    const authMethod = resolveProfileAuthMethod(providersRoot) ?? "oauth-personal";
    return {
      source: "manager",
      credentials: parseManagerTokenCredentials(detail.token, authMethod),
      quota: asRecord(detail.quota)
    };
  }

  return null;
}

function parseManagerTokenCredentials(
  tokenValue: unknown,
  authMethod: AntigravityAuthMethod
): AntigravityCredentials | null {
  const tokenRecord = asRecord(tokenValue);
  if (tokenRecord === null) {
    return null;
  }
  const accessToken = readNonEmptyString(tokenRecord.access_token);
  if (accessToken === null) {
    return null;
  }
  const expirySeconds = readFiniteNumber(tokenRecord.expiry_timestamp);
  const expiresAtIso = readTimestamp(tokenRecord.expiry);
  const expiresAt =
    expirySeconds !== null && expirySeconds > 0
      ? normalizeEpochMs(expirySeconds)
      : expiresAtIso !== null
        ? Date.parse(expiresAtIso)
        : null;

  return {
    kind: "cli-token",
    authMethod,
    accessToken,
    refreshToken: readNonEmptyString(tokenRecord.refresh_token),
    expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null,
    clientId: readNonEmptyString(tokenRecord.client_id),
    clientSecret: readNonEmptyString(tokenRecord.client_secret),
    projectId: readNonEmptyString(tokenRecord.project_id)
  };
}

function isProfileCredentialsUsable(creds: AntigravityCredentials, nowMs: number): boolean {
  if (creds.kind === "acp-token" || canRefreshCredentials(creds)) {
    return true;
  }
  return creds.expiresAt === null || creds.expiresAt - nowMs >= EXPIRES_SKEW_MS;
}

function readFileMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readProfileCredentials(
  providersRoot: string,
  nowMs: number = Date.now()
): AntigravityCredentials | null {
  if (!existsSync(providersRoot)) {
    return null;
  }

  let accounts: string[];
  try {
    accounts = readdirSync(providersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }

  const candidates: Array<{
    account: string;
    usable: boolean;
    mtimeMs: number;
    kindRank: number;
    credentials: AntigravityCredentials;
  }> = [];

  for (const account of accounts) {
    const acpRoot = join(providersRoot, account, ACP_DIR_NAME);
    if (!existsSync(acpRoot)) {
      continue;
    }

    const authMethod = readAuthMethod(join(acpRoot, AUTH_STATE_REL_PATH)) ?? "oauth-personal";
    const acpTokenPath = join(acpRoot, ACP_TOKEN_FILE);
    if (existsSync(acpTokenPath)) {
      const parsed = parseAcpTokenFile(readFileUtf8(acpTokenPath), authMethod);
      if (parsed !== null) {
        candidates.push({
          account,
          usable: isProfileCredentialsUsable(parsed, nowMs),
          mtimeMs: readFileMtimeMs(acpTokenPath),
          kindRank: 1,
          credentials: parsed
        });
      }
    }

    const cliTokenPath = join(acpRoot, CLI_TOKEN_FILE);
    if (existsSync(cliTokenPath)) {
      const raw = readFileUtf8(cliTokenPath);
      const parsed = raw === null ? null : parseCliTokenCredentials(raw, authMethod);
      if (parsed !== null) {
        candidates.push({
          account,
          usable: isProfileCredentialsUsable(parsed, nowMs),
          mtimeMs: readFileMtimeMs(cliTokenPath),
          kindRank: 0,
          credentials: parsed
        });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const usableDiff = Number(right.usable) - Number(left.usable);
    if (usableDiff !== 0) {
      return usableDiff;
    }
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }
    if (right.kindRank !== left.kindRank) {
      return right.kindRank - left.kindRank;
    }
    return left.account.localeCompare(right.account);
  });

  return candidates[0]?.credentials ?? null;
}

function resolveProfileAuthMethod(providersRoot: string): AntigravityAuthMethod | null {
  if (!existsSync(providersRoot)) {
    return null;
  }
  try {
    const accounts = readdirSync(providersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const account of accounts) {
      const authMethod = readAuthMethod(join(providersRoot, account, ACP_DIR_NAME, AUTH_STATE_REL_PATH));
      if (authMethod !== null) {
        return authMethod;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readAuthMethod(filePath: string): AntigravityAuthMethod | null {
  const raw = readFileUtf8(filePath);
  if (raw === null) {
    return null;
  }
  const record = parseJsonRecord(raw);
  const methodId = record === null ? null : readNonEmptyString(record.methodId);
  if (methodId === "oauth-personal" || methodId === "oauth-business") {
    return methodId;
  }
  return null;
}

function parseAcpTokenFile(
  raw: string | null,
  authMethod: AntigravityAuthMethod
): AntigravityCredentials | null {
  if (raw === null) {
    return null;
  }
  const record = parseJsonRecord(raw);
  if (record === null) {
    return null;
  }
  const clientId = readNonEmptyString(record.client_id);
  const clientSecret = readNonEmptyString(record.client_secret);
  const refreshToken = readNonEmptyString(record.refresh_token);
  if (clientId === null || clientSecret === null || refreshToken === null) {
    return null;
  }
  return {
    kind: "acp-token",
    authMethod,
    clientId,
    clientSecret,
    refreshToken,
    projectId: readNonEmptyString(record.project_id)
  };
}

function parseCliTokenCredentials(
  raw: string,
  authMethod: AntigravityAuthMethod
): AntigravityCredentials | null {
  const outer = parseJsonRecord(raw);
  if (outer === null) {
    return null;
  }
  const tokenRecord = asRecord(outer.token) ?? outer;
  const accessToken = readNonEmptyString(tokenRecord.access_token);
  if (accessToken === null) {
    return null;
  }
  const expiresAtIso = readTimestamp(tokenRecord.expiry);
  const expiresAt = expiresAtIso === null ? null : Date.parse(expiresAtIso);
  return {
    kind: "cli-token",
    authMethod,
    accessToken,
    refreshToken: readNonEmptyString(tokenRecord.refresh_token),
    expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null,
    clientId: readNonEmptyString(outer.client_id ?? tokenRecord.client_id),
    clientSecret: readNonEmptyString(outer.client_secret ?? tokenRecord.client_secret),
    projectId: readNonEmptyString(outer.project_id ?? tokenRecord.project_id)
  };
}

async function readSystemKeyringSecret(): Promise<string | null> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", KEYRING_SERVICE, "-a", KEYRING_ACCOUNT, "-w"],
        { encoding: "utf8", timeout: KEYRING_TIMEOUT_MS }
      );
      const trimmed = stdout.trim();
      return trimmed.length === 0 ? null : trimmed;
    } catch {
      return null;
    }
  }

  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync(
        "secret-tool",
        ["lookup", "service", KEYRING_SERVICE, "username", KEYRING_ACCOUNT],
        { encoding: "utf8", timeout: KEYRING_TIMEOUT_MS }
      );
      const trimmed = stdout.trim();
      return trimmed.length === 0 ? null : trimmed;
    } catch {
      return null;
    }
  }

  return null;
}

function resolveDefaultProvidersRoot(): string {
  return (
    readNonEmptyString(process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT) ??
    join(homedir(), ".t3", "userdata", "providers", "antigravity")
  );
}

function resolveDefaultCliHome(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

function resolveDefaultManagerRoot(): string {
  return join(homedir(), ".antigravity_tools");
}

function readFileUtf8(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
