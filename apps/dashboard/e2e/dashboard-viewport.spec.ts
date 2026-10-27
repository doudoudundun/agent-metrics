import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 }
] as const;

const overviewFixture = {
  mode: "calendar",
  range: "day",
  timezone: "Asia/Shanghai",
  windowStart: "2026-05-26T16:00:00.000Z",
  windowEnd: "2026-05-27T16:00:00.000Z",
  updatedAt: "2026-05-27T10:30:00.000Z",
  sessionCount: 3,
  turnCount: 24,
  responseCount: 12,
  totalTokens: 45678,
  inputTokens: 22345,
  outputTokens: 19876,
  cacheReadTokens: 2345,
  cacheCreationTokens: 1112,
  tokensByModel: [
    {
      model: "gpt-5-codex",
      sourceVendor: "codex",
      totalTokens: 33000,
      inputTokens: 15000,
      outputTokens: 12000,
      cacheReadTokens: 4000,
      cacheCreationTokens: 2000,
      costUsd: 1.23,
      avgOutputTokensPerSecond: 33.2,
      avgFirstTokenLatencyMs: 1200,
      cacheHitRate: 0.190476
    }
  ],
  totalToolCalls: 12,
  successfulExecutions: 10,
  failedExecutions: 2,
  startedOnlyExecutions: 0,
  successRate: 0.8333,
  editOperationCount: 4,
  affectedFileCount: 7,
  insertions: 42,
  deletions: 8,
  sourceBreakdown: [
    {
      sourceVendor: "claude-code",
      sessionCount: 3,
      turnCount: 24,
      totalTokens: 45678,
      toolCalls: 12,
      costUsd: 1.23,
      cacheHitRate: 0.0923
    }
  ],
  providerBreakdown: [],
  totalCostUsd: 1.23
};

const scopedFixture = {
  mode: overviewFixture.mode,
  range: overviewFixture.range,
  timezone: overviewFixture.timezone,
  windowStart: overviewFixture.windowStart,
  windowEnd: overviewFixture.windowEnd,
  updatedAt: overviewFixture.updatedAt
};

async function installDashboardApiMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }";
    document.head.appendChild(style);
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;

    if (pathname.endsWith("/api/overview")) {
      await route.fulfill({ json: overviewFixture });
      return;
    }
    if (pathname.endsWith("/api/tools")) {
      await route.fulfill({
        json: {
          ...scopedFixture,
          rows: [{ toolName: "Read", count: 6, failures: 0, averageDurationMs: 15 }]
        }
      });
      return;
    }
    if (pathname.endsWith("/api/token-trend")) {
      await route.fulfill({
        json: {
          ...scopedFixture,
          rows: [
            {
              bucketStart: "2026-05-27T00:00:00.000Z",
              label: "05-27 08:00",
              totalTokens: 15000,
              inputTokens: 7000,
              outputTokens: 5000,
              cacheReadTokens: 2000,
              cacheCreationTokens: 1000,
              cacheHitRate: 0.2
            }
          ]
        }
      });
      return;
    }
    if (pathname.endsWith("/api/sessions")) {
      await route.fulfill({
        json: {
          ...scopedFixture,
          rows: [
            {
              sourceInstanceId: "claude-transcript",
              sessionId: "ses_1",
              workspacePath: "D:/projects/dev/agent-metrics",
              sourceVendor: "claude-code",
              sourceAdapters: ["claude-transcript"],
              providerId: "claude-code",
              providerHost: null,
              turnCount: 14,
              totalTokens: 45678,
              lastModel: "gpt-5-codex",
              lastActivityAt: "2026-05-27T10:00:00.000Z"
            }
          ],
          nextCursor: null
        }
      });
      return;
    }
    if (pathname.endsWith("/api/sync/status")) {
      await route.fulfill({
        json: {
          generatedAt: overviewFixture.updatedAt,
          shuttingDown: false,
          adapters: [
            {
              adapterInstanceId: "claude",
              status: "ready",
              lastSuccessAt: "2026-05-27T10:00:00.000Z"
            }
          ]
        }
      });
      return;
    }
    if (pathname.endsWith("/api/cursor/account-usage")) {
      await route.fulfill({
        json: {
          sourceInstanceId: "cursor:default",
          email: null,
          planName: "Pro",
          planTier: "pro",
          subscriptionStatus: null,
          hostname: null,
          machineId: null,
          billingCycleStart: "2026-05-01T00:00:00.000Z",
          billingCycleEnd: "2026-05-31T00:00:00.000Z",
          totalSpendCents: 6200,
          includedSpendCents: 5000,
          bonusSpendCents: 0,
          limitCents: 2000,
          remainingCents: 800,
          autoPercentUsed: 66,
          apiPercentUsed: 4,
          totalPercentUsed: 70,
          displayMessage: null,
          syncedAt: overviewFixture.updatedAt,
          modelAggregations: [],
          modelUsageTotalCostCents: 0
        }
      });
      return;
    }
    if (pathname.endsWith("/api/key-usage")) {
      await route.fulfill({
        json: { updatedAt: overviewFixture.updatedAt, entries: [] }
      });
      return;
    }

    await route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
}

test.describe("dashboard viewport matrix", () => {
  test.beforeEach(async ({ page }) => {
    await installDashboardApiMocks(page);
  });

  for (const viewport of VIEWPORTS) {
    test(`renders operational workspace at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.waitForSelector(".dashboard-topbar");
      await page.waitForSelector(".overview-strip");

      await expect(page.locator(".hero-panel")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Operational workspace" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Operational status summary" })).toBeVisible();

      if (viewport.width === 1280 && viewport.height === 720) {
        const topBar = page.locator(".dashboard-topbar");
        const overviewStrip = page.locator(".overview-strip");
        await expect(topBar).toBeInViewport();
        await expect(overviewStrip).toBeInViewport();
      }

      await assertNoHorizontalOverflow(page);
      await expect(page.locator(".dashboard-page")).toHaveScreenshot(
        `dashboard-ready-${viewport.width}x${viewport.height}.png`
      );
    });
  }
});
