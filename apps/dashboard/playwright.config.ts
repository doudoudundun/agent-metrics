import { defineConfig } from "@playwright/test";

// Pinned with root devDependency @playwright/test ^1.52.0
const host = "127.0.0.1";
const port = 4191;
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002
    }
  },
  use: {
    baseURL,
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1280, height: 720 }
  },
  webServer: {
    command: `corepack pnpm exec vite --host ${host} --port ${port}`,
    cwd: import.meta.dirname,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
