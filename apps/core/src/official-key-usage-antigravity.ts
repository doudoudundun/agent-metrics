import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { persistOfficialKeyUsage, type OfficialKeyUsageSnapshot, type OfficialKeyUsageWindow } from "./official-key-usage.js";
import type { SqliteDatabaseLike } from "./domain-types.js";

/**
 * Antigravity quota snapshots harvested from Google Cloud Code Assist's
 * internal quota endpoints (`retrieveUserQuotaSummary`, falling back to
 * `fetchAvailableModels`).
 *
 * Credentials are read from the local Antigravity ACP profile directory
 * (`acp_token.json` or `antigravity-oauth-token`) or, when no profile override
 * is active, from the OS system keyring entry written by the `antigravity` CLI
 * (`service = "gemini"`, `account = "antigravity"`). Credentials are kept in
 * memory for the current run only and never logged or written back.
 */

export const ANTIGRAVITY_KEY_USAGE_VENDOR = "antigravity";
export const ANTIGRAVITY_KEY_USAGE_SOURCE = "antigravity-quota-api";

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const DEFAULT_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACP_DIR_NAME = "antigravity-acp";
const ACP_TOKEN_FILE = "acp_token.json";
const CLI_TOKEN_FILE = "antigravity-oauth-token";
const AUTH_STATE_REL_PATH = join("cache", "acp-auth-state.json");
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "antigravity";
const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";
const GO_KEYRING_HEX_PREFIX = "go-keyring-encoded:";
const EXPIRES_SKEW_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const KEYRING_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FIVE_HOURS_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

const execFileAsync = promisify(execFile);

type FetchLike = typeof fetch;

type Logger = {
  warn: (message: string) => void;
  info?: (message: string) => void;
};

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

export type CollectAntigravityKeyUsageOptions = {
  providersRoot?: string;
  dailyEndpoint?: string;
  prodEndpoint?: string;
  oauthTokenUrl?: string;
  readKeyringSecret?: () => Promise<string | null>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: Logger;
};

export type CollectAntigravityKeyUsageResult = {
  snapshotsFound: number;
  snapshotsStored: number;
};

type ApiPostResult =
  | { ok: true; text: string }
  | { ok: false; status: number | null; message: string };

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
 * Maps a `retrieveUserQuotaSummary` response into `OfficialKeyUsageSnapshot`
 * entries — one card per model group (e.g. `Gemini Models`, `Claude and GPT
 * models`), pairing its `5h` bucket as `primary` and `weekly` bucket as
 * `secondary`.
 */
export function parseAntigravityQuotaSummary(
  payload: unknown,
  observedAt: string = new Date().toISOString(),
  requestedAtMs: number = Date.parse(observedAt)
): OfficialKeyUsageSnapshot[] {
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }

  const rawGroups = Array.isArray(record.groups) ? record.groups : [];
  const hasGroupBuckets = rawGroups.some((group) => {
    const groupRecord = asRecord(group);
    return groupRecord !== null && Array.isArray(groupRecord.buckets) && groupRecord.buckets.length > 0;
  });

  const groups: Array<{ displayName: string | null; buckets: unknown[] }> = hasGroupBuckets
    ? rawGroups
        .map((group) => {
          const groupRecord = asRecord(group);
          if (groupRecord === null || !Array.isArray(groupRecord.buckets)) {
            return null;
          }
          return {
            displayName: readNonEmptyString(groupRecord.displayName),
            buckets: groupRecord.buckets
          };
        })
        .filter((group): group is { displayName: string | null; buckets: unknown[] } => group !== null)
    : Array.isArray(record.buckets) && record.buckets.length > 0
      ? [{ displayName: null, buckets: record.buckets }]
      : [];

  if (groups.length === 0) {
    return [];
  }

  const groupedSnapshots = new Map<
    string,
    {
      limitId: string;
      limitName: string;
      primary: OfficialKeyUsageWindow | null;
      secondary: OfficialKeyUsageWindow | null;
    }
  >();

  for (const group of groups) {
    for (const rawBucket of group.buckets) {
      const bucket = asRecord(rawBucket);
      if (bucket === null || bucket.disabled === true) {
        continue;
      }

      const bucketId = readNonEmptyString(bucket.bucketId);
      const remainingFraction = readFiniteNumber(bucket.remainingFraction);
      if (bucketId === null || remainingFraction === null) {
        continue;
      }

      const windowKind = readNonEmptyString(bucket.window);
      const windowMinutes =
        windowKind === "5h" ? FIVE_HOURS_MINUTES : windowKind === "weekly" ? WEEKLY_MINUTES : 0;
      const resetsAt = resolveSummaryResetTime({
        resetTime: bucket.resetTime,
        remainingFraction,
        description: readNonEmptyString(bucket.description),
        windowMinutes,
        requestedAtMs
      });

      const windowValue: OfficialKeyUsageWindow = {
        usedPercent: fractionToUsedPercent(remainingFraction),
        windowMinutes,
        resetsAt
      };

      const identity = resolveBucketGroupIdentity(bucketId, group.displayName);
      let entry = groupedSnapshots.get(identity.limitId);
      if (entry === undefined) {
        entry = {
          limitId: identity.limitId,
          limitName: identity.limitName,
          primary: null,
          secondary: null
        };
        groupedSnapshots.set(identity.limitId, entry);
      }

      if (windowKind === "5h") {
        entry.primary = windowValue;
      } else if (windowKind === "weekly") {
        entry.secondary = windowValue;
      } else if (entry.primary === null) {
        entry.primary = windowValue;
      } else if (entry.secondary === null) {
        entry.secondary = windowValue;
      }
    }
  }

  return [...groupedSnapshots.values()]
    .filter((entry) => entry.primary !== null || entry.secondary !== null)
    .map((entry) => ({
      vendor: ANTIGRAVITY_KEY_USAGE_VENDOR,
      source: ANTIGRAVITY_KEY_USAGE_SOURCE,
      limitId: entry.limitId,
      limitName: entry.limitName,
      primary: entry.primary,
      secondary: entry.secondary,
      credits: null,
      expiresAt: null,
      observedAt
    }));
}

/**
 * Fallback parser for `fetchAvailableModels` when `retrieveUserQuotaSummary`
 * returns no buckets (e.g. older accounts). Aggregates by provider family
 * (`Gemini`, `Claude`, `GPT`), keeping the highest `usedPercent` per family.
 */
export function parseAntigravityAvailableModels(
  payload: unknown,
  observedAt: string = new Date().toISOString()
): OfficialKeyUsageSnapshot[] {
  const record = asRecord(payload);
  const models = record === null ? null : asRecord(record.models);
  if (models === null) {
    return [];
  }

  const byFamily = new Map<
    string,
    {
      limitId: string;
      limitName: string;
      primary: OfficialKeyUsageWindow | null;
      secondary: OfficialKeyUsageWindow | null;
    }
  >();

  for (const [modelId, rawModel] of Object.entries(models)) {
    const model = asRecord(rawModel);
    if (model === null) {
      continue;
    }

    const family = resolveModelFamily(modelId, readNonEmptyString(model.modelProvider));
    if (family === null) {
      continue;
    }

    const quotaWindow = parseModelQuotaWindow(model.quotaInfo, 0);
    const weeklyWindow = parseModelQuotaWindow(model.weeklyQuotaInfo, WEEKLY_MINUTES);
    if (quotaWindow === null && weeklyWindow === null) {
      continue;
    }

    let entry = byFamily.get(family.limitId);
    if (entry === undefined) {
      entry = {
        limitId: family.limitId,
        limitName: family.limitName,
        primary: null,
        secondary: null
      };
      byFamily.set(family.limitId, entry);
    }

    if (
      quotaWindow !== null &&
      (entry.primary === null || quotaWindow.usedPercent > entry.primary.usedPercent)
    ) {
      entry.primary = quotaWindow;
    }
    if (
      weeklyWindow !== null &&
      (entry.secondary === null || weeklyWindow.usedPercent > entry.secondary.usedPercent)
    ) {
      entry.secondary = weeklyWindow;
    }
  }

  return [...byFamily.values()]
    .filter((entry) => entry.primary !== null || entry.secondary !== null)
    .map((entry) => ({
      vendor: ANTIGRAVITY_KEY_USAGE_VENDOR,
      source: ANTIGRAVITY_KEY_USAGE_SOURCE,
      limitId: entry.limitId,
      limitName: entry.limitName,
      primary: entry.primary,
      secondary: entry.secondary,
      credits: null,
      expiresAt: null,
      observedAt
    }));
}

/**
 * Reads local Antigravity credentials (from profile files under `providersRoot`,
 * or the OS keyring when no source-isolation override is active). Returns null
 * when no usable credentials are present.
 */
export async function readAntigravityCredentials(
  options: {
    providersRoot?: string;
    readKeyringSecret?: () => Promise<string | null>;
  } = {}
): Promise<AntigravityCredentials | null> {
  const providersRoot = options.providersRoot ?? resolveDefaultProvidersRoot();
  const profileCredentials = readProfileCredentials(providersRoot);
  if (profileCredentials !== null) {
    return profileCredentials;
  }

  const allowSystemKeyring =
    options.readKeyringSecret !== undefined ||
    (options.providersRoot === undefined &&
      readNonEmptyString(process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT) === null);
  if (!allowSystemKeyring) {
    return null;
  }

  const rawSecret = await (options.readKeyringSecret ?? readSystemKeyringSecret)();
  if (rawSecret === null) {
    return null;
  }

  const decoded = decodeGoKeyringSecret(rawSecret);
  const authMethod = resolveProfileAuthMethod(providersRoot) ?? "oauth-personal";
  return parseCliTokenCredentials(decoded, authMethod);
}

/** Global fetch cannot be detached from its binding on every runtime. */
const defaultFetch: FetchLike = async (input, init) => {
  return await globalThis.fetch(input, init);
};

/**
 * Queries Antigravity's official quota endpoints and persists the resulting
 * snapshots into `official_key_usage`. Missing credentials, expired tokens,
 * or failed requests log one line and return zero counts instead of throwing.
 */
export async function collectAntigravityKeyUsage(
  db: SqliteDatabaseLike,
  options: CollectAntigravityKeyUsageOptions = {}
): Promise<CollectAntigravityKeyUsageResult> {
  const now = options.now ?? (() => new Date());
  const log: Logger = options.log ?? { warn: (message: string) => console.warn(message) };
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const oauthTokenUrl = stripTrailingSlashes(options.oauthTokenUrl ?? DEFAULT_OAUTH_TOKEN_URL);
  const dailyEndpoint = stripTrailingSlashes(options.dailyEndpoint ?? DAILY_ENDPOINT);
  const prodEndpoint = stripTrailingSlashes(options.prodEndpoint ?? PROD_ENDPOINT);
  const collectedAt = now();

  const credentials = await readAntigravityCredentials({
    providersRoot: options.providersRoot,
    readKeyringSecret: options.readKeyringSecret
  });
  if (credentials === null) {
    log.info?.("official key usage skipped for antigravity: no local credentials");
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  let accessToken = await resolveAccessToken({
    credentials,
    oauthTokenUrl,
    fetchImpl,
    now,
    log
  });
  if (accessToken === null) {
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  const endpoints =
    credentials.authMethod === "oauth-business"
      ? [prodEndpoint, dailyEndpoint]
      : [dailyEndpoint, prodEndpoint];
  const requestBody = credentials.projectId ? { project: credentials.projectId } : {};

  let result = await fetchSnapshotsFromEndpoints({
    endpoints,
    accessToken,
    requestBody,
    fetchImpl,
    now,
    observedAt: collectedAt.toISOString(),
    log
  });

  if (result.unauthorized && canRefreshCredentials(credentials)) {
    const refreshed = await refreshOAuthAccessToken({
      oauthTokenUrl,
      credentials,
      fetchImpl,
      log
    });
    if (refreshed !== null) {
      accessToken = refreshed;
      result = await fetchSnapshotsFromEndpoints({
        endpoints,
        accessToken,
        requestBody,
        fetchImpl,
        now,
        observedAt: collectedAt.toISOString(),
        log
      });
    }
  }

  if (result.snapshots.length === 0) {
    return { snapshotsFound: 0, snapshotsStored: 0 };
  }

  return {
    snapshotsFound: result.snapshots.length,
    snapshotsStored: persistOfficialKeyUsage(db, result.snapshots, collectedAt.toISOString())
  };
}

async function resolveAccessToken(input: {
  credentials: AntigravityCredentials;
  oauthTokenUrl: string;
  fetchImpl: FetchLike;
  now: () => Date;
  log: Logger;
}): Promise<string | null> {
  if (input.credentials.kind === "acp-token") {
    return await refreshOAuthAccessToken({
      oauthTokenUrl: input.oauthTokenUrl,
      credentials: input.credentials,
      fetchImpl: input.fetchImpl,
      log: input.log
    });
  }

  const expired =
    input.credentials.expiresAt !== null &&
    input.credentials.expiresAt - input.now().getTime() < EXPIRES_SKEW_MS;
  if (!expired) {
    return input.credentials.accessToken;
  }

  if (canRefreshCredentials(input.credentials)) {
    return await refreshOAuthAccessToken({
      oauthTokenUrl: input.oauthTokenUrl,
      credentials: input.credentials,
      fetchImpl: input.fetchImpl,
      log: input.log
    });
  }

  input.log.warn(
    "official key usage skipped for antigravity: saved sign-in has expired"
  );
  return null;
}

function canRefreshCredentials(credentials: AntigravityCredentials): boolean {
  if (credentials.kind === "acp-token") {
    return true;
  }
  return (
    credentials.clientId !== null &&
    credentials.clientSecret !== null &&
    credentials.refreshToken !== null
  );
}

async function refreshOAuthAccessToken(input: {
  oauthTokenUrl: string;
  credentials: AntigravityCredentials;
  fetchImpl: FetchLike;
  log: Logger;
}): Promise<string | null> {
  if (
    input.credentials.kind === "cli-token" &&
    (input.credentials.clientId === null ||
      input.credentials.clientSecret === null ||
      input.credentials.refreshToken === null)
  ) {
    return null;
  }

  const clientId = input.credentials.clientId!;
  const clientSecret = input.credentials.clientSecret!;
  const refreshToken = input.credentials.refreshToken!;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  let response: Response;
  try {
    response = await input.fetchImpl(input.oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    input.log.warn(
      `official key usage token refresh failed for antigravity: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  if (!response.ok) {
    input.log.warn(
      `official key usage token refresh failed for antigravity (HTTP ${String(response.status)})`
    );
    return null;
  }

  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return null;
    }
    const record = parseJsonRecord(text);
    return record === null ? null : readNonEmptyString(record.access_token);
  } catch {
    return null;
  }
}

async function fetchSnapshotsFromEndpoints(input: {
  endpoints: string[];
  accessToken: string;
  requestBody: Record<string, unknown>;
  fetchImpl: FetchLike;
  now: () => Date;
  observedAt: string;
  log: Logger;
}): Promise<{ snapshots: OfficialKeyUsageSnapshot[]; unauthorized: boolean }> {
  let unauthorized = false;
  let lastError: string | null = null;

  for (const endpoint of input.endpoints) {
    const requestedAtMs = input.now().getTime();
    const summaryRes = await postQuotaEndpoint({
      url: `${endpoint}/v1internal:retrieveUserQuotaSummary`,
      accessToken: input.accessToken,
      body: input.requestBody,
      fetchImpl: input.fetchImpl
    });

    if (summaryRes.ok) {
      const payload = parseJsonRecord(summaryRes.text);
      const snapshots = parseAntigravityQuotaSummary(payload, input.observedAt, requestedAtMs);
      if (snapshots.length > 0) {
        return { snapshots, unauthorized: false };
      }
    } else {
      if (summaryRes.status === 401) {
        unauthorized = true;
      }
      lastError = summaryRes.message;
    }
  }

  if (unauthorized) {
    return { snapshots: [], unauthorized: true };
  }

  for (const endpoint of input.endpoints) {
    const modelsRes = await postQuotaEndpoint({
      url: `${endpoint}/v1internal:fetchAvailableModels`,
      accessToken: input.accessToken,
      body: input.requestBody,
      fetchImpl: input.fetchImpl
    });

    if (modelsRes.ok) {
      const payload = parseJsonRecord(modelsRes.text);
      const snapshots = parseAntigravityAvailableModels(payload, input.observedAt);
      if (snapshots.length > 0) {
        return { snapshots, unauthorized: false };
      }
    } else {
      if (modelsRes.status === 401) {
        unauthorized = true;
      }
      lastError = modelsRes.message;
    }
  }

  if (lastError !== null) {
    input.log.warn(`official key usage request failed for antigravity: ${lastError}`);
  }
  return { snapshots: [], unauthorized };
}

async function postQuotaEndpoint(input: {
  url: string;
  accessToken: string;
  body: Record<string, unknown>;
  fetchImpl: FetchLike;
}): Promise<ApiPostResult> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": antigravityUserAgent()
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      redirect: "manual"
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: `request failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, message: `HTTP ${String(response.status)}` };
  }

  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES * 4) {
      return { ok: false, status: response.status, message: "response exceeded size limit" };
    }
    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      message: `reading response failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function readProfileCredentials(providersRoot: string): AntigravityCredentials | null {
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
        return parsed;
      }
    }

    const cliTokenPath = join(acpRoot, CLI_TOKEN_FILE);
    if (existsSync(cliTokenPath)) {
      const raw = readFileUtf8(cliTokenPath);
      const parsed = raw === null ? null : parseCliTokenCredentials(raw, authMethod);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
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

function resolveBucketGroupIdentity(
  bucketId: string,
  groupDisplayName: string | null
): { limitId: string; limitName: string } {
  if (bucketId.startsWith("gemini-argon-")) {
    return { limitId: "gemini-argon", limitName: groupDisplayName ?? "Gemini Argon" };
  }
  if (bucketId.startsWith("gemini-carbon-")) {
    return { limitId: "gemini-carbon", limitName: groupDisplayName ?? "Gemini Carbon" };
  }
  if (bucketId.startsWith("gemini-")) {
    return { limitId: "gemini", limitName: groupDisplayName ?? "Gemini Models" };
  }
  if (bucketId.startsWith("3p-")) {
    return { limitId: "3p", limitName: groupDisplayName ?? "Claude and GPT models" };
  }
  const normalizedPrefix = bucketId.replace(/-(?:5h|weekly)$/u, "");
  return {
    limitId: normalizedPrefix.length > 0 ? normalizedPrefix : bucketId,
    limitName: groupDisplayName ?? (normalizedPrefix.length > 0 ? normalizedPrefix : bucketId)
  };
}

function resolveModelFamily(
  modelId: string,
  modelProvider: string | null
): { limitId: string; limitName: string } | null {
  if (modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")) {
    return { limitId: "gemini", limitName: "Gemini Models" };
  }
  if (modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")) {
    return { limitId: "claude", limitName: "Claude Models" };
  }
  if (modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")) {
    return { limitId: "gpt", limitName: "GPT Models" };
  }
  return null;
}

function parseModelQuotaWindow(
  value: unknown,
  windowMinutes: number
): OfficialKeyUsageWindow | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const remainingFraction = readFiniteNumber(record.remainingFraction);
  if (remainingFraction === null) {
    return null;
  }
  return {
    usedPercent: fractionToUsedPercent(remainingFraction),
    windowMinutes,
    resetsAt: readTimestamp(record.resetTime)
  };
}

/**
 * Unused buckets often report `remainingFraction: 1` with `resetTime ≈ now +
 * windowDuration`. Treat that synthetic rolling horizon as `null` so the UI
 * does not show a countdown before the window actually starts.
 */
function resolveSummaryResetTime(input: {
  resetTime: unknown;
  remainingFraction: number;
  description: string | null;
  windowMinutes: number;
  requestedAtMs: number;
}): string | null {
  const iso = readTimestamp(input.resetTime);
  if (iso === null) {
    return null;
  }
  if (
    input.remainingFraction === 1 &&
    input.description === null &&
    input.windowMinutes > 0 &&
    Number.isFinite(input.requestedAtMs) &&
    Math.abs(Date.parse(iso) - input.requestedAtMs - input.windowMinutes * 60_000) <= 60_000
  ) {
    return null;
  }
  return iso;
}

function fractionToUsedPercent(remainingFraction: number): number {
  const clampedRemaining = Math.min(1, Math.max(0, remainingFraction));
  return Number(((1 - clampedRemaining) * 100).toFixed(2));
}

function resolveDefaultProvidersRoot(): string {
  return (
    readNonEmptyString(process.env.AGENT_METRICS_ANTIGRAVITY_PROVIDERS_ROOT) ??
    join(homedir(), ".t3", "userdata", "providers", "antigravity")
  );
}

function antigravityUserAgent(): string {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`;
}

function readFileUtf8(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
