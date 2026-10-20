import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  AGENT_METRICS_SOURCE_ENV_VARS,
  isolateSources,
  pathIsInsideRoot,
  type SourceEnvVarName
} from "./source-isolation.js";

// Tests for the isolation helper itself. These must not depend on any adapter;
// they only assert process.env manipulation. They DO set real env vars during
// the run, so each test cleans up and there is a global afterEach guard.

let activeCleanups: Array<() => void> = [];

beforeEach(() => {
  activeCleanups = [];
});

afterEach(() => {
  for (const cleanup of activeCleanups) {
    cleanup();
  }
  activeCleanups = [];
});

describe("AGENT_METRICS_SOURCE_ENV_VARS", () => {
  it("lists exactly the 18 known source-path env vars", () => {
    // Pinned count: spec section 20.1 enumerates Claude discovery roots,
    // OpenCode db/models, ZCode db/models, MiMo db/models, Kimi Code home, DSH
    // home, WorkBuddy home, Codex sessions/logs-db/config, and Cursor tracking-db/
    // workspace-storage/storage-json/global-storage-db/projects-root. Adding a
    // source requires adding it here and to the helper.
    expect(AGENT_METRICS_SOURCE_ENV_VARS).toHaveLength(18);
    expect([...AGENT_METRICS_SOURCE_ENV_VARS].sort()).toEqual(
      [
        "AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS",
        "AGENT_METRICS_CODEX_CONFIG_PATH",
        "AGENT_METRICS_CODEX_LOGS_DB_PATH",
        "AGENT_METRICS_CODEX_SESSIONS_ROOT",
        "AGENT_METRICS_CURSOR_GLOBAL_STORAGE_DB_PATH",
        "AGENT_METRICS_CURSOR_PROJECTS_ROOT",
        "AGENT_METRICS_CURSOR_STORAGE_JSON_PATH",
        "AGENT_METRICS_CURSOR_TRACKING_DB_PATH",
        "AGENT_METRICS_CURSOR_WORKSPACE_STORAGE_ROOT",
        "AGENT_METRICS_DSH_HOME",
        "AGENT_METRICS_KIMICODE_HOME",
        "AGENT_METRICS_MIMO_DB_PATH",
        "AGENT_METRICS_MIMO_MODELS_PATH",
        "AGENT_METRICS_OPENCODE_DB_PATH",
        "AGENT_METRICS_OPENCODE_MODELS_PATH",
        "AGENT_METRICS_WORKBUDDY_HOME",
        "AGENT_METRICS_ZCODE_DB_PATH",
        "AGENT_METRICS_ZCODE_MODELS_PATH"
      ].sort()
    );
  });
});

describe("isolateSources", () => {
  it("redirects every known source env var under the temp root", async () => {
    const isolated = await isolateSources();
    activeCleanups.push(isolated.cleanup);

    for (const name of AGENT_METRICS_SOURCE_ENV_VARS) {
      expect(process.env[name], `${name} should be set`).toBeDefined();
      const redirected = process.env[name]!;
      expect(
        pathIsInsideRoot(redirected, isolated.rootDir),
        `${name}=${redirected} should be under ${isolated.rootDir}`
      ).toBe(true);
      expect(isolated.env[name as SourceEnvVarName]).toBe(redirected);
    }
  });

  it("restores previously-set values on cleanup", async () => {
    const probeName: SourceEnvVarName = "AGENT_METRICS_CODEX_SESSIONS_ROOT";
    const original = "/some/preexisting/codex-sessions";
    process.env[probeName] = original;

    const isolated = await isolateSources();
    expect(process.env[probeName]).not.toBe(original);
    isolated.cleanup();

    expect(process.env[probeName]).toBe(original);
    delete process.env[probeName];
  });

  it("deletes env vars that were unset before isolation", async () => {
    const probeName: SourceEnvVarName = "AGENT_METRICS_OPENCODE_DB_PATH";
    delete process.env[probeName];

    const isolated = await isolateSources();
    expect(process.env[probeName]).toBeDefined();
    isolated.cleanup();

    expect(process.env[probeName]).toBeUndefined();
  });

  it("cleanup is idempotent", async () => {
    const isolated = await isolateSources();
    isolated.cleanup();
    // A second call must not throw and must not re-mutate env.
    expect(() => isolated.cleanup()).not.toThrow();
  });

  it("honors an explicit rootDir without creating or deleting it", async () => {
    // Use join() so the literal survives platform path-separator normalization.
    const fixedRoot = join("nonexistent", "explicit-root-for-isolate-test");
    const isolated = await isolateSources({ rootDir: fixedRoot });
    activeCleanups.push(isolated.cleanup);

    expect(isolated.rootDir).toBe(fixedRoot);
    for (const name of AGENT_METRICS_SOURCE_ENV_VARS) {
      expect(process.env[name]).toContain(fixedRoot);
    }
  });

  it("honors per-var overrides while keeping the rest isolated", async () => {
    const realFixtureDb = join("tmp", "real-opencode-fixture.db");
    const isolated = await isolateSources({
      overrides: { AGENT_METRICS_OPENCODE_DB_PATH: realFixtureDb }
    });
    activeCleanups.push(isolated.cleanup);

    expect(process.env.AGENT_METRICS_OPENCODE_DB_PATH).toBe(realFixtureDb);
    // Every other var is still redirected under the root.
    for (const name of AGENT_METRICS_SOURCE_ENV_VARS) {
      if (name === "AGENT_METRICS_OPENCODE_DB_PATH") {
        continue;
      }
      expect(
        pathIsInsideRoot(process.env[name]!, isolated.rootDir),
        `${name} should still be isolated`
      ).toBe(true);
    }
  });
});

describe("pathIsInsideRoot", () => {
  it("treats exact root match and nested children as inside", () => {
    expect(pathIsInsideRoot("/a/b", "/a/b")).toBe(true);
    expect(pathIsInsideRoot("/a/b/c", "/a/b")).toBe(true);
    expect(pathIsInsideRoot("/a/bc", "/a/b")).toBe(false);
  });

  it("handles backslash roots on windows-style paths", () => {
    expect(pathIsInsideRoot("C:\\tmp\\fixture\\db.sqlite", "C:\\tmp\\fixture")).toBe(true);
  });
});
