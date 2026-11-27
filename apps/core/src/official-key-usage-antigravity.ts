import type { SqliteDatabaseLike } from "./domain-types.js";
import { replaceVendorOfficialKeyUsage, type OfficialKeyUsageSnapshot } from "./official-key-usage.js";
import {
  canRefreshCredentials,
  EXPIRES_SKEW_MS,
  readAntigravityAccount,
  type AntigravityCredentialOptions,
  type AntigravityCredentials
} from "./official-key-usage-antigravity-auth.js";
import {
  ANTIGRAVITY_KEY_USAGE_VENDOR,
  parseAntigravityAvailableModels,
  parseAntigravityManagerQuota,
  parseAntigravityQuotaSummary
} from "./official-key-usage-antigravity-quota.js";
import { parseJsonRecord, readNonEmptyString } from "./official-key-usage-antigravity-values.js";

export {
  decodeGoKeyringSecret,
  readAntigravityCredentials,
  type AntigravityAuthMethod,
  type AntigravityCredentials
} from "./official-key-usage-antigravity-auth.js";
export {
  ANTIGRAVITY_KEY_USAGE_SOURCE,
  ANTIGRAVITY_KEY_USAGE_VENDOR,
  ANTIGRAVITY_MANAGER_CACHE_SOURCE,
  parseAntigravityAvailableModels,
  parseAntigravityManagerQuota,
  parseAntigravityQuotaSummary
} from "./official-key-usage-antigravity-quota.js";

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const DEFAULT_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type FetchLike = typeof fetch;

type Logger = {
  warn: (message: string) => void;
  info?: (message: string) => void;
};

export type CollectAntigravityKeyUsageOptions = AntigravityCredentialOptions & {
  dailyEndpoint?: string;
  prodEndpoint?: string;
  oauthTokenUrl?: string;
  fetchImpl?: FetchLike;
  log?: Logger;
};

export type CollectAntigravityKeyUsageResult = {
  snapshotsFound: number;
  snapshotsStored: number;
};

type ApiPostResult =
  | { ok: true; text: string }
  | { ok: false; status: number | null; message: string };

/** Global fetch cannot be detached from its binding on every runtime. */
const defaultFetch: FetchLike = async (input, init) => {
  return await globalThis.fetch(input, init);
};

/**
 * Queries Antigravity's official quota endpoints and persists the resulting
 * snapshots into `official_key_usage`. When Antigravity Manager
 * (`~/.antigravity_tools`) is active, follows its selected account with a cache
 * fallback to `quota.quota_groups`. Missing credentials, expired tokens, or
 * failed requests log one line and return zero counts instead of throwing.
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
  const observedAt = collectedAt.toISOString();
  const account = await readAntigravityAccount({ ...options, now });
  let snapshots: OfficialKeyUsageSnapshot[] = [];
  if (account.credentials !== null) {
    snapshots = await collectLiveSnapshotsForCredentials({
      credentials: account.credentials,
      oauthTokenUrl,
      dailyEndpoint,
      prodEndpoint,
      fetchImpl,
      now,
      observedAt,
      log: account.source === "manager" ? { warn: () => undefined, info: log.info } : log,
      retryWithoutProjectOnEmpty: account.source === "manager"
    });
  }

  if (snapshots.length === 0 && account.source === "manager") {
    snapshots = parseAntigravityManagerQuota(account.quota, observedAt);
    if (snapshots.length === 0 && account.credentials === null) {
      log.info?.("official key usage skipped for antigravity: active manager account has no token or cache");
    }
  } else if (account.credentials === null) {
    log.info?.("official key usage skipped for antigravity: no local credentials");
  }

  return {
    snapshotsFound: snapshots.length,
    snapshotsStored: snapshots.length === 0
      ? 0
      : replaceVendorOfficialKeyUsage(db, ANTIGRAVITY_KEY_USAGE_VENDOR, snapshots, observedAt)
  };
}

async function collectLiveSnapshotsForCredentials(input: {
  credentials: AntigravityCredentials;
  oauthTokenUrl: string;
  dailyEndpoint: string;
  prodEndpoint: string;
  fetchImpl: FetchLike;
  now: () => Date;
  observedAt: string;
  log: Logger;
  retryWithoutProjectOnEmpty: boolean;
}): Promise<OfficialKeyUsageSnapshot[]> {
  let accessToken = await resolveAccessToken({
    credentials: input.credentials,
    oauthTokenUrl: input.oauthTokenUrl,
    fetchImpl: input.fetchImpl,
    now: input.now,
    log: input.log
  });
  if (accessToken === null) {
    return [];
  }

  const endpoints =
    input.credentials.authMethod === "oauth-business"
      ? [input.prodEndpoint, input.dailyEndpoint]
      : [input.dailyEndpoint, input.prodEndpoint];
  const requestBody = input.credentials.projectId ? { project: input.credentials.projectId } : {};

  const request = {
    endpoints,
    requestBody,
    fetchImpl: input.fetchImpl,
    now: input.now,
    observedAt: input.observedAt,
    log: input.log
  };
  let result = await fetchSnapshotsFromEndpoints({ ...request, accessToken });

  if (result.unauthorized && canRefreshCredentials(input.credentials)) {
    const refreshed = await refreshOAuthAccessToken({
      oauthTokenUrl: input.oauthTokenUrl,
      credentials: input.credentials,
      fetchImpl: input.fetchImpl,
      log: input.log
    });
    if (refreshed !== null) {
      accessToken = refreshed;
      result = await fetchSnapshotsFromEndpoints({ ...request, accessToken });
    }
  }

  if (
    input.retryWithoutProjectOnEmpty &&
    result.snapshots.length === 0 &&
    !result.unauthorized &&
    Object.keys(requestBody).length > 0
  ) {
    result = await fetchSnapshotsFromEndpoints({ ...request, accessToken, requestBody: {} });
  }

  return result.snapshots;
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

function antigravityUserAgent(): string {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`;
}

function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}
