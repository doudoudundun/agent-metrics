import type { CursorAuthCredentials } from "./cursor-auth.js";

export const CURSOR_API_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const DEFAULT_CURSOR_API_BASE_URL = "https://api2.cursor.sh";

export type CursorPlanUsage = {
  totalSpendCents: number;
  includedSpendCents: number;
  bonusSpendCents: number;
  limitCents: number;
  remainingCents: number | null;
  autoPercentUsed: number;
  apiPercentUsed: number;
  totalPercentUsed: number;
};

export type CursorCurrentPeriodUsage = {
  billingCycleStart: string;
  billingCycleEnd: string;
  planUsage: CursorPlanUsage;
  displayMessage: string | null;
};

export type CursorPlanInfo = {
  planName: string | null;
  includedAmountCents: number | null;
  price: string | null;
  billingCycleEnd: string | null;
};

export type CursorModelAggregation = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCents: number;
  tier: number | null;
};

export type CursorAggregatedUsageEvents = {
  models: CursorModelAggregation[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalCostCents: number;
};

export type CursorOfficialUsagePayload = {
  email: string | null;
  planTier: string | null;
  subscriptionStatus: string | null;
  machineId: string | null;
  hostname: string;
  currentPeriod: CursorCurrentPeriodUsage;
  planInfo: CursorPlanInfo;
  modelUsage: CursorAggregatedUsageEvents;
  todayModelUsage: CursorAggregatedUsageEvents;
  todayDayKey: string;
  todayCreatedAt: string;
};

type FetchLike = typeof fetch;

function resolveApiBaseUrl(): string {
  const configured = process.env.AGENT_METRICS_CURSOR_API_BASE_URL?.trim();
  return configured && configured.length > 0 ? configured.replace(/\/+$/u, "") : DEFAULT_CURSOR_API_BASE_URL;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const number = readFiniteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function parseUnixMsTimestamp(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function readNonNegativeIntLoose(value: unknown): number {
  const number = readNonNegativeNumber(value);
  if (number === null) {
    return 0;
  }
  return Math.trunc(number);
}

function parsePlanUsage(value: unknown): CursorPlanUsage | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const totalSpendCents = readNonNegativeInteger(record.totalSpend);
  const includedSpendCents = readNonNegativeInteger(record.includedSpend);
  const bonusSpendCents = readNonNegativeInteger(record.bonusSpend) ?? 0;
  const limitCents = readNonNegativeInteger(record.limit);
  const autoPercentUsed = readFiniteNumber(record.autoPercentUsed);
  const apiPercentUsed = readFiniteNumber(record.apiPercentUsed);
  const totalPercentUsed = readFiniteNumber(record.totalPercentUsed);

  if (
    totalSpendCents === null ||
    includedSpendCents === null ||
    limitCents === null ||
    autoPercentUsed === null ||
    apiPercentUsed === null ||
    totalPercentUsed === null
  ) {
    return null;
  }

  const remaining = readNonNegativeInteger(record.remaining);

  return {
    totalSpendCents,
    includedSpendCents,
    bonusSpendCents,
    limitCents,
    remainingCents: remaining,
    autoPercentUsed,
    apiPercentUsed,
    totalPercentUsed
  };
}

export function parseCurrentPeriodUsageResponse(payload: unknown): CursorCurrentPeriodUsage | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const billingCycleStart = parseUnixMsTimestamp(record.billingCycleStart);
  const billingCycleEnd = parseUnixMsTimestamp(record.billingCycleEnd);
  const planUsage = parsePlanUsage(record.planUsage);

  if (!billingCycleStart || !billingCycleEnd || !planUsage) {
    return null;
  }

  return {
    billingCycleStart,
    billingCycleEnd,
    planUsage,
    displayMessage: readString(record.displayMessage)
  };
}

export function parsePlanInfoResponse(payload: unknown): CursorPlanInfo | null {
  const record = asRecord(payload);
  const planInfo = asRecord(record?.planInfo);
  if (!planInfo) {
    return null;
  }

  return {
    planName: readString(planInfo.planName),
    includedAmountCents: readNonNegativeInteger(planInfo.includedAmountCents),
    price: readString(planInfo.price),
    billingCycleEnd: parseUnixMsTimestamp(planInfo.billingCycleEnd)
  };
}

export function parseAggregatedUsageEventsResponse(payload: unknown): CursorAggregatedUsageEvents {
  const record = asRecord(payload);
  const aggregations = Array.isArray(record?.aggregations) ? record.aggregations : [];
  const models: CursorModelAggregation[] = [];

  for (const entry of aggregations) {
    const item = asRecord(entry);
    if (!item) {
      continue;
    }
    const model = readString(item.modelIntent) ?? readString(item.model);
    if (!model) {
      continue;
    }
    const totalCents = readNonNegativeNumber(item.totalCents) ?? 0;
    models.push({
      model,
      inputTokens: readNonNegativeIntLoose(item.inputTokens),
      outputTokens: readNonNegativeIntLoose(item.outputTokens),
      cacheReadTokens: readNonNegativeIntLoose(item.cacheReadTokens),
      cacheWriteTokens: readNonNegativeIntLoose(item.cacheWriteTokens),
      totalCents,
      tier: readNonNegativeInteger(item.tier)
    });
  }

  models.sort((left, right) => right.totalCents - left.totalCents);

  return {
    models,
    totalInputTokens: readNonNegativeIntLoose(record?.totalInputTokens),
    totalOutputTokens: readNonNegativeIntLoose(record?.totalOutputTokens),
    totalCacheWriteTokens: readNonNegativeIntLoose(record?.totalCacheWriteTokens),
    totalCacheReadTokens: readNonNegativeIntLoose(record?.totalCacheReadTokens),
    totalCostCents: readNonNegativeNumber(record?.totalCostCents) ?? 0
  };
}

const EMPTY_MODEL_USAGE: CursorAggregatedUsageEvents = {
  models: [],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheWriteTokens: 0,
  totalCacheReadTokens: 0,
  totalCostCents: 0
};

/** Calendar-day bounds for a fixed-offset zone such as Asia/Shanghai (+08:00, no DST). */
export function resolveCalendarDayWindow(
  now: Date,
  timeZone = "Asia/Shanghai"
): { dayKey: string; startMs: number; endMs: number; createdAt: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const dayKey = formatter.format(now);
  // China has no DST; keep the project default explicit.
  const offset = timeZone === "Asia/Shanghai" || timeZone === "Asia/Chongqing" ? "+08:00" : "+08:00";
  const startMs = Date.parse(`${dayKey}T00:00:00${offset}`);
  const endMs = startMs + 24 * 60 * 60 * 1000;
  // Overview windows are [start, now). A fixed noon timestamp is still "in the future"
  // before local noon and gets filtered out — clamp to an instant inside the open window.
  const createdAtMs = Math.min(Math.max(now.getTime(), startMs), endMs - 1);
  const createdAt = new Date(createdAtMs).toISOString();
  return { dayKey, startMs, endMs, createdAt };
}

async function postDashboardService(
  fetchImpl: FetchLike,
  baseUrl: string,
  accessToken: string,
  method: string,
  body: unknown
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; body: string }> {
  const response = await fetchImpl(`${baseUrl}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1"
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, body: text };
  }

  try {
    return { ok: true, payload: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: response.status, body: text };
  }
}

export async function refreshCursorAccessToken(input: {
  refreshToken: string;
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
}): Promise<string | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.apiBaseUrl ?? resolveApiBaseUrl();
  const response = await fetchImpl(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CURSOR_API_CLIENT_ID,
      refresh_token: input.refreshToken
    })
  });

  if (!response.ok) {
    return null;
  }

  const payload = asRecord(await response.json());
  const accessToken = readString(payload?.access_token);
  if (!accessToken || payload?.shouldLogout === true) {
    return null;
  }

  return accessToken;
}

async function authorizedPostDashboardService(
  fetchImpl: FetchLike,
  baseUrl: string,
  credentials: CursorAuthCredentials,
  method: string,
  body: unknown
): Promise<{ ok: true; payload: unknown; accessToken: string } | { ok: false; reason: string }> {
  let accessToken = credentials.accessToken;
  let result = await postDashboardService(fetchImpl, baseUrl, accessToken, method, body);

  if (!result.ok && result.status === 401 && credentials.refreshToken) {
    const refreshed = await refreshCursorAccessToken({
      refreshToken: credentials.refreshToken,
      fetchImpl,
      apiBaseUrl: baseUrl
    });
    if (refreshed) {
      accessToken = refreshed;
      result = await postDashboardService(fetchImpl, baseUrl, accessToken, method, body);
    }
  }

  if (!result.ok) {
    return {
      ok: false,
      reason: result.status === 401 ? "Cursor session expired. Re-login in Cursor IDE." : `Cursor API error (${result.status}).`
    };
  }

  return { ok: true, payload: result.payload, accessToken };
}

export async function fetchCursorOfficialUsage(input: {
  credentials: CursorAuthCredentials;
  hostname: string;
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
  now?: () => Date;
  timeZone?: string;
}): Promise<{ ok: true; data: CursorOfficialUsagePayload } | { ok: false; reason: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.apiBaseUrl ?? resolveApiBaseUrl();
  const now = (input.now ?? (() => new Date()))();
  const timeZone = input.timeZone ?? "Asia/Shanghai";

  const periodResult = await authorizedPostDashboardService(
    fetchImpl,
    baseUrl,
    input.credentials,
    "GetCurrentPeriodUsage",
    {}
  );
  if (!periodResult.ok) {
    return periodResult;
  }

  const currentPeriod = parseCurrentPeriodUsageResponse(periodResult.payload);
  if (!currentPeriod) {
    return { ok: false, reason: "Cursor usage response was malformed." };
  }

  const credentialsWithToken = {
    ...input.credentials,
    accessToken: periodResult.accessToken
  };

  const planResult = await authorizedPostDashboardService(
    fetchImpl,
    baseUrl,
    credentialsWithToken,
    "GetPlanInfo",
    {}
  );

  const planInfo = planResult.ok ? parsePlanInfoResponse(planResult.payload) : null;
  const accessToken = planResult.ok ? planResult.accessToken : periodResult.accessToken;

  const billingCycleStartMs = String(Date.parse(currentPeriod.billingCycleStart));
  const billingCycleEndMs = String(Date.parse(currentPeriod.billingCycleEnd));
  const aggregatedResult = await authorizedPostDashboardService(
    fetchImpl,
    baseUrl,
    {
      ...credentialsWithToken,
      accessToken
    },
    "GetAggregatedUsageEvents",
    {
      startDate: billingCycleStartMs,
      endDate: billingCycleEndMs
    }
  );

  const modelUsage = aggregatedResult.ok
    ? parseAggregatedUsageEventsResponse(aggregatedResult.payload)
    : EMPTY_MODEL_USAGE;

  const todayWindow = resolveCalendarDayWindow(now, timeZone);
  const todayResult = await authorizedPostDashboardService(
    fetchImpl,
    baseUrl,
    {
      ...credentialsWithToken,
      accessToken: aggregatedResult.ok ? aggregatedResult.accessToken : accessToken
    },
    "GetAggregatedUsageEvents",
    {
      startDate: String(todayWindow.startMs),
      endDate: String(todayWindow.endMs)
    }
  );

  const todayModelUsage = todayResult.ok
    ? parseAggregatedUsageEventsResponse(todayResult.payload)
    : EMPTY_MODEL_USAGE;

  return {
    ok: true,
    data: {
      email: input.credentials.email,
      planTier: input.credentials.planTier,
      subscriptionStatus: input.credentials.subscriptionStatus,
      machineId: input.credentials.machineId,
      hostname: input.hostname,
      currentPeriod,
      planInfo: planInfo ?? {
        planName: input.credentials.planTier,
        includedAmountCents: currentPeriod.planUsage.limitCents,
        price: null,
        billingCycleEnd: currentPeriod.billingCycleEnd
      },
      modelUsage,
      todayModelUsage,
      todayDayKey: todayWindow.dayKey,
      todayCreatedAt: todayWindow.createdAt
    }
  };
}
