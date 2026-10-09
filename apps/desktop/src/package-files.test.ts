import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop packaging files", () => {
  it("bundles the main process so packaged Electron does not resolve workspace contracts", () => {
    const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
      scripts?: { build?: string };
      dependencies?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";
    expect(buildScript).toContain("bundle-main.mjs");
    expect(packageJson.dependencies?.["@agent-metrics/contracts"]).toBe("workspace:*");
  });
});
