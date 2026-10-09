import { describe, expect, it, vi } from "vitest";
import {
  fetchCursorOfficialUsage,
  parseAggregatedUsageEventsResponse,
  parseCurrentPeriodUsageResponse,
  parsePlanInfoResponse,
  refreshCursorAccessToken
} from "./cursor-official-api.js";
import type { CursorAuthCredentials } from "./cursor-auth.js";

const credentials: CursorAuthCredentials = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  email: "dev@example.com",
  planTier: "pro",
  subscriptionStatus: "active",
  machineId: "machine-123"
};

describe("parseCurrentPeriodUsageResponse", () => {
  it("parses GetCurrentPeriodUsage payload", () => {
    const parsed = parseCurrentPeriodUsageResponse({
      billingCycleStart: "1768399334000",
      billingCycleEnd: "1771077734000",
      planUsage: {
        totalSpend: 2322,
        includedSpend: 2000,
        bonusSpend: 322,
        limit: 2000,
        remaining: 0,
        autoPercentUsed: 13.2,
        apiPercentUsed: 46.4,
        totalPercentUsed: 15.5
      },
      displayMessage: "You've used 46% of your usage limit"
    });

    expect(parsed).toMatchObject({
      planUsage: {
        totalSpendCents: 2322,
        includedSpendCents: 2000,
        bonusSpendCents: 322,
        limitCents: 2000,
        remainingCents: 0,
        autoPercentUsed: 13.2,
        apiPercentUsed: 46.4,
        totalPercentUsed: 15.5
      },
      displayMessage: "You've used 46% of your usage limit"
    });
    expect(parsed?.billingCycleStart).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(parsed?.billingCycleEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describe("parsePlanInfoResponse", () => {
  it("parses GetPlanInfo payload", () => {
    const parsed = parsePlanInfoResponse({
      planInfo: {
        planName: "Pro",
        includedAmountCents: 2000,
        price: "$20/mo",
        billingCycleEnd: "1771077734000"
      }
    });

    expect(parsed).toMatchObject({
      planName: "Pro",
      includedAmountCents: 2000,
      price: "$20/mo"
    });
    expect(parsed?.billingCycleEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describe("parseAggregatedUsageEventsResponse", () => {
  it("parses GetAggregatedUsageEvents payload", () => {
    const parsed = parseAggregatedUsageEventsResponse({
      aggregations: [
        {
          modelIntent: "composer-2.5-fast",
          inputTokens: "100",
          outputTokens: "20",
          cacheReadTokens: "500",
          totalCents: 12.5,
          tier: 2
        },
        {
          modelIntent: "cursor-grok-4.5-high-fast",
          inputTokens: "200",
          outputTokens: "40",
          cacheReadTokens: "800",
          totalCents: 30,
          tier: 2
        }
      ],
      totalInputTokens: "300",
      totalOutputTokens: "60",
      totalCacheWriteTokens: "0",
      totalCacheReadTokens: "1300",
      totalCostCents: 42.5
    });

    expect(parsed.models[0]?.model).toBe("cursor-grok-4.5-high-fast");
    expect(parsed.models[1]?.totalCents).toBe(12.5);
    expect(parsed.totalCostCents).toBe(42.5);
  });
});

describe("fetchCursorOfficialUsage", () => {
  it("merges current period, plan info, and model aggregations", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/GetCurrentPeriodUsage")) {
        return new Response(
          JSON.stringify({
            billingCycleStart: "1768399334000",
            billingCycleEnd: "1771077734000",
            planUsage: {
              totalSpend: 1500,
              includedSpend: 1500,
              bonusSpend: 0,
              limit: 2000,
              remaining: 500,
              autoPercentUsed: 10,
              apiPercentUsed: 20,
              totalPercentUsed: 15
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/GetPlanInfo")) {
        return new Response(
          JSON.stringify({
            planInfo: {
              planName: "Pro",
              includedAmountCents: 2000,
              price: "$20/mo",
              billingCycleEnd: "1771077734000"
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/GetAggregatedUsageEvents")) {
        return new Response(
          JSON.stringify({
            aggregations: [
              {
                modelIntent: "composer-2.5-fast",
                inputTokens: "10",
                outputTokens: "2",
                cacheReadTokens: "5",
                totalCents: 1.25,
                tier: 2
              }
            ],
            totalCostCents: 1.25
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchCursorOfficialUsage({
      credentials,
      hostname: "dev-box",
      fetchImpl,
      apiBaseUrl: "https://api2.cursor.sh"
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.email).toBe("dev@example.com");
      expect(result.data.hostname).toBe("dev-box");
      expect(result.data.currentPeriod.planUsage.totalPercentUsed).toBe(15);
      expect(result.data.planInfo.planName).toBe("Pro");
      expect(result.data.modelUsage.models).toHaveLength(1);
      expect(result.data.modelUsage.models[0]?.model).toBe("composer-2.5-fast");
      expect(result.data.todayDayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(result.data.todayModelUsage.models.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("refreshes token after 401 and retries", async () => {
    let usageCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-token", shouldLogout: false }), {
          status: 200
        });
      }

      if (url.endsWith("/GetCurrentPeriodUsage")) {
        usageCalls += 1;
        if (usageCalls === 1) {
          return new Response("unauthorized", { status: 401 });
        }

        return new Response(
          JSON.stringify({
            billingCycleStart: "1768399334000",
            billingCycleEnd: "1771077734000",
            planUsage: {
              totalSpend: 100,
              includedSpend: 100,
              bonusSpend: 0,
              limit: 2000,
              autoPercentUsed: 1,
              apiPercentUsed: 2,
              totalPercentUsed: 3
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/GetPlanInfo")) {
        return new Response(JSON.stringify({ planInfo: { planName: "Pro" } }), { status: 200 });
      }

      if (url.endsWith("/GetAggregatedUsageEvents")) {
        return new Response(JSON.stringify({ aggregations: [], totalCostCents: 0 }), { status: 200 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await fetchCursorOfficialUsage({
      credentials,
      hostname: "dev-box",
      fetchImpl,
      apiBaseUrl: "https://api2.cursor.sh"
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api2.cursor.sh/oauth/token",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("refreshCursorAccessToken", () => {
  it("returns null when refresh response indicates logout", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "", shouldLogout: true }), { status: 200 })
    );

    await expect(
      refreshCursorAccessToken({
        refreshToken: "refresh-token",
        fetchImpl,
        apiBaseUrl: "https://api2.cursor.sh"
      })
    ).resolves.toBeNull();
  });
});
