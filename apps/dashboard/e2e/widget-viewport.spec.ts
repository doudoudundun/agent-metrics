import { expect, test, type Page } from "@playwright/test";

const widgetSnapshot = {
  generatedAt: new Date().toISOString(),
  scope: {
    mode: "calendar",
    range: "day",
    windowStart: "2026-05-26T16:00:00.000Z",
    windowEnd: "2026-05-27T10:00:00.000Z"
  },
  metrics: {
    totalTokens: 45678,
    inputTokens: 22345,
    outputTokens: 19876,
    cacheReadTokens: 2345,
    cacheCreationTokens: 1112,
    sessionCount: 3,
    logicalToolCalls: 12,
    cacheHitRate: 0.5,
    toolSuccessRate: 10 / 12,
    editOperationCount: 4,
    affectedFileCount: 7,
    totalCostUsd: 0.28
  }
};

async function installWidgetMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, {
      __widgetCalls: calls,
      agentMetricsDesktop: {
        getPlatformInfo: async () => ({ platform: "win32", supportsLaunchAtLogin: true, supportsWidget: true }),
        getSettings: async () => ({ widgetModeOnStartup: "collapsed" }),
        showMainWindow: async () => {
          calls.push("showMainWindow");
          return { visible: true };
        },
        hideWidget: async () => ({ visible: false, mode: "collapsed" }),
        setWidgetMode: async (mode: string) => {
          calls.push(`setWidgetMode:${mode}`);
          return { visible: true, mode };
        },
        pointerEnter: async () => ({}),
        pointerLeave: async () => ({}),
        focusWithin: async (focused: boolean) => {
          calls.push(`focusWithin:${focused}`);
          return {};
        },
        pointerBegin: async () => ({ activationEligible: true, dragging: false }),
        pointerUpdate: async () => ({ activationEligible: true, dragging: false }),
        pointerEnd: async () => ({ activationEligible: true, dragging: false }),
        showWidgetMenu: async () => ({ shown: true })
      }
    });

    const style = document.createElement("style");
    style.textContent =
      "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }";
    (document.head ?? document.documentElement).appendChild(style);
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/widget-snapshot")) {
      await route.fulfill({ json: { ...widgetSnapshot, generatedAt: new Date().toISOString() } });
      return;
    }
    if (url.pathname.endsWith("/api/sync/status")) {
      await route.fulfill({ json: { generatedAt: new Date().toISOString(), shuttingDown: false, adapters: [] } });
      return;
    }
    if (url.pathname.endsWith("/api/sync") && route.request().method() === "POST") {
      await route.fulfill({
        json: { requestId: "req_widget", acceptedAt: new Date().toISOString(), runs: [] }
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
}

async function assertNoOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight);
}

test.describe("desktop widget", () => {
  test.beforeEach(async ({ page }) => {
    await installWidgetMocks(page);
  });

  test("renders the collapsed instrument at 88x88", async ({ page }) => {
    await page.setViewportSize({ width: 88, height: 88 });
    await page.goto("/?surface=desktop-widget");

    await expect(page.getByLabel("Agent Metrics widget collapsed")).toBeVisible();
    await expect(page.getByText("46K")).toBeVisible();
    await expect(page.getByText("Tokens")).toBeVisible();
    await expect(page.getByText("$0.28")).toBeVisible();
    await expect(page.getByText("USD")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Cache hit 50%" })).toHaveCount(0);
    await assertNoOverflow(page);
    await expect(page.locator(".widget-page")).toHaveScreenshot("widget-collapsed-88x88.png");
  });

  test("renders the expanded instrument and preserves desktop actions", async ({ page }) => {
    await page.setViewportSize({ width: 384, height: 340 });
    await page.goto("/?surface=desktop-widget");

    await expect(page.locator(".widget-page__hero")).toBeVisible();
    await expect(page.getByText("45,678")).toBeVisible();
    await expect(page.getByText("Sessions")).toBeVisible();
    await expect(page.getByText("Tool success")).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pin widget" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Collapse widget" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Main", exact: true })).toBeVisible();
    await assertNoOverflow(page);
    await expect(page.locator(".widget-page")).toHaveScreenshot("widget-expanded-384x340.png");

    await page.getByRole("button", { name: "Pin widget" }).click();
    await expect(page.getByRole("button", { name: "Unpin widget" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Main", exact: true }).click();

    const calls = await page.evaluate(() =>
      (window as unknown as { __widgetCalls: string[] }).__widgetCalls
    );
    expect(calls).toContain("setWidgetMode:pinned");
    expect(calls).toContain("showMainWindow");
    expect(calls.indexOf("setWidgetMode:pinned")).toBeLessThan(calls.indexOf("focusWithin:false"));
  });
});
