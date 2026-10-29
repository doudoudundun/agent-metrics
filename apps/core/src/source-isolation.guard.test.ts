// Phase 0 source-isolation guard.
//
// Spec section 20.1 requires every test source path to stay under its fixture
// root. This test calls the exact resolver functions used by production sync
// entrypoints so an adapter cannot silently stop honoring an isolation env var.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveDefaultClaudeDiscoveryRoots } from "@agent-metrics/adapters-claude";
import { resolveCodexSourcePaths } from "@agent-metrics/adapters-codex";
import { resolveCursorSourcePaths } from "@agent-metrics/adapters-cursor";
import { resolveOpenCodeSourcePaths, resolveZCodeSourcePaths } from "@agent-metrics/adapters-opencode";
import { resolveKimicodeSourcePaths } from "@agent-metrics/adapters-kimicode";
import { resolveMiMoSourcePaths } from "@agent-metrics/adapters-mimo";
import { resolveDshSourcePaths } from "@agent-metrics/adapters-dsh";
import {
  resolveCodebuddyHome,
  resolveWorkbuddySourcePaths,
  resolveWorkbuddySyncRoots
} from "@agent-metrics/adapters-workbuddy";
import { resolveCodebuddyLogRoot } from "@agent-metrics/adapters-codebuddy-log";
import {
  AGENT_METRICS_SOURCE_ENV_VARS,
  isolateSources,
  pathIsInsideRoot,
  type IsolatedSources,
  type SourceEnvVarName
} from "@agent-metrics/test-utils";

let isolated: IsolatedSources | null = null;

beforeEach(async () => {
  isolated = await isolateSources();
});

afterEach(() => {
  isolated?.cleanup();
  isolated = null;
});

function expectedPath(name: SourceEnvVarName): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} was not set by isolateSources(); add it to AGENT_METRICS_SOURCE_ENV_VARS`);
  }
  return value;
}

function expectInsideFixtureRoot(path: string): void {
  expect(pathIsInsideRoot(path, isolated!.rootDir), `${path} should stay under ${isolated!.rootDir}`).toBe(true);
}

function expectOutsideFixtureRoot(path: string): void {
  expect(pathIsInsideRoot(path, isolated!.rootDir), `${path} should escape ${isolated!.rootDir}`).toBe(false);
}

describe("source isolation guard", () => {
  it("resolves all 20 production source paths under the fixture root", () => {
    expect(AGENT_METRICS_SOURCE_ENV_VARS).toHaveLength(20);

    const claudeRoots = resolveDefaultClaudeDiscoveryRoots("unused-by-resolver");
    const opencode = resolveOpenCodeSourcePaths();
    const zcode = resolveZCodeSourcePaths();
    const mimo = resolveMiMoSourcePaths();
    const kimicode = resolveKimicodeSourcePaths();
    const dsh = resolveDshSourcePaths();
    const workbuddy = resolveWorkbuddySourcePaths();
    const codex = resolveCodexSourcePaths();
    const cursor = resolveCursorSourcePaths();

    expect(claudeRoots).toEqual([expectedPath("AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS")]);
    for (const path of claudeRoots) {
      expectInsideFixtureRoot(path);
    }

    expect(opencode).toEqual({
      primaryDbPath: expectedPath("AGENT_METRICS_OPENCODE_DB_PATH"),
      primaryModelsPath: expectedPath("AGENT_METRICS_OPENCODE_MODELS_PATH")
    });
    Object.values(opencode).forEach(expectInsideFixtureRoot);

    expect(zcode).toEqual({
      dbPath: expectedPath("AGENT_METRICS_ZCODE_DB_PATH"),
      modelsPath: expectedPath("AGENT_METRICS_ZCODE_MODELS_PATH")
    });
    Object.values(zcode).forEach(expectInsideFixtureRoot);

    expect(mimo).toEqual({
      dbPath: expectedPath("AGENT_METRICS_MIMO_DB_PATH"),
      modelsPath: expectedPath("AGENT_METRICS_MIMO_MODELS_PATH")
    });
    Object.values(mimo).forEach(expectInsideFixtureRoot);

    expect(kimicode.homePath).toBe(expectedPath("AGENT_METRICS_KIMICODE_HOME"));
    expectInsideFixtureRoot(kimicode.homePath);
    expectInsideFixtureRoot(kimicode.sessionsRoot);
    expectInsideFixtureRoot(kimicode.sessionIndexPath);

    expect(dsh).toEqual({
      homePath: expectedPath("AGENT_METRICS_DSH_HOME"),
      sessionsRoot: join(expectedPath("AGENT_METRICS_DSH_HOME"), "sessions")
    });
    expectInsideFixtureRoot(dsh.homePath);
    expectInsideFixtureRoot(dsh.sessionsRoot);

    expect(workbuddy).toEqual({
      homePath: expectedPath("AGENT_METRICS_WORKBUDDY_HOME"),
      projectsRoot: join(expectedPath("AGENT_METRICS_WORKBUDDY_HOME"), "projects")
    });
    expectInsideFixtureRoot(workbuddy.homePath);
    expectInsideFixtureRoot(workbuddy.projectsRoot);

    // CodeBuddy CLI transcripts are collected by the WorkBuddy adapter.
    const syncRoots = resolveWorkbuddySyncRoots();
    expect(syncRoots).toEqual([
      {
        homePath: expectedPath("AGENT_METRICS_WORKBUDDY_HOME"),
        projectsRoot: join(expectedPath("AGENT_METRICS_WORKBUDDY_HOME"), "projects"),
        primary: true
      },
      {
        homePath: expectedPath("AGENT_METRICS_CODEBUDDY_HOME"),
        projectsRoot: join(expectedPath("AGENT_METRICS_CODEBUDDY_HOME"), "projects"),
        primary: false
      }
    ]);
    for (const root of syncRoots) {
      expectInsideFixtureRoot(root.homePath);
      expectInsideFixtureRoot(root.projectsRoot);
    }

    // CodeBuddy CLI request logs are the only record of headless CLI runs.
    expect(resolveCodebuddyLogRoot()).toBe(expectedPath("AGENT_METRICS_CODEBUDDY_LOG_ROOT"));
    expectInsideFixtureRoot(resolveCodebuddyLogRoot());

    expect(codex).toEqual({
      sessionsRoot: expectedPath("AGENT_METRICS_CODEX_SESSIONS_ROOT"),
      sessionsRoots: [expectedPath("AGENT_METRICS_CODEX_SESSIONS_ROOT")],
      logsDbPath: expectedPath("AGENT_METRICS_CODEX_LOGS_DB_PATH"),
      configPath: expectedPath("AGENT_METRICS_CODEX_CONFIG_PATH")
    });
    expectInsideFixtureRoot(codex.sessionsRoot);
    for (const path of codex.sessionsRoots) {
      expectInsideFixtureRoot(path);
    }
    expectInsideFixtureRoot(codex.logsDbPath);
    expectInsideFixtureRoot(codex.configPath);

    expect(cursor).toEqual({
      trackingDbPath: expectedPath("AGENT_METRICS_CURSOR_TRACKING_DB_PATH"),
      workspaceStorageRoot: expectedPath("AGENT_METRICS_CURSOR_WORKSPACE_STORAGE_ROOT"),
      storageJsonPath: expectedPath("AGENT_METRICS_CURSOR_STORAGE_JSON_PATH"),
      globalStorageDbPath: expectedPath("AGENT_METRICS_CURSOR_GLOBAL_STORAGE_DB_PATH"),
      cursorProjectsRoot: expectedPath("AGENT_METRICS_CURSOR_PROJECTS_ROOT")
    });
    Object.values(cursor).forEach(expectInsideFixtureRoot);
  });

  it("falls back outside the fixture root when the Claude override is removed", () => {
    delete process.env.AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS;
    expectOutsideFixtureRoot(resolveDefaultClaudeDiscoveryRoots("unused-by-resolver")[0]!);
  });

  it("falls back outside the fixture root when any OpenCode, ZCode, MiMo, KimiCode, or DSH override is removed", () => {
    const cases: Array<{
      name: SourceEnvVarName;
      resolve: () => string;
    }> = [
      {
        name: "AGENT_METRICS_OPENCODE_DB_PATH",
        resolve: () => resolveOpenCodeSourcePaths().primaryDbPath
      },
      {
        name: "AGENT_METRICS_OPENCODE_MODELS_PATH",
        resolve: () => resolveOpenCodeSourcePaths().primaryModelsPath
      },
      {
        name: "AGENT_METRICS_ZCODE_DB_PATH",
        resolve: () => resolveZCodeSourcePaths().dbPath
      },
      {
        name: "AGENT_METRICS_ZCODE_MODELS_PATH",
        resolve: () => resolveZCodeSourcePaths().modelsPath
      },
      {
        name: "AGENT_METRICS_MIMO_DB_PATH",
        resolve: () => resolveMiMoSourcePaths().dbPath
      },
      {
        name: "AGENT_METRICS_MIMO_MODELS_PATH",
        resolve: () => resolveMiMoSourcePaths().modelsPath
      },
      {
        name: "AGENT_METRICS_KIMICODE_HOME",
        resolve: () => resolveKimicodeSourcePaths().homePath
      },
      {
        name: "AGENT_METRICS_DSH_HOME",
        resolve: () => resolveDshSourcePaths().homePath
      }
    ];

    for (const { name, resolve } of cases) {
      const redirected = expectedPath(name);
      delete process.env[name];
      expectOutsideFixtureRoot(resolve());
      process.env[name] = redirected;
    }
  });

  it("falls back outside the fixture root when any Codex override is removed", () => {
    const cases: Array<{
      name: SourceEnvVarName;
      resolve: () => string;
    }> = [
      {
        name: "AGENT_METRICS_CODEX_SESSIONS_ROOT",
        resolve: () => resolveCodexSourcePaths().sessionsRoot
      },
      {
        name: "AGENT_METRICS_CODEX_LOGS_DB_PATH",
        resolve: () => resolveCodexSourcePaths().logsDbPath
      },
      {
        name: "AGENT_METRICS_CODEX_CONFIG_PATH",
        resolve: () => resolveCodexSourcePaths().configPath
      }
    ];

    for (const { name, resolve } of cases) {
      const redirected = expectedPath(name);
      delete process.env[name];
      expectOutsideFixtureRoot(resolve());
      process.env[name] = redirected;
    }
  });

  it("falls back outside the fixture root when the CodeBuddy override is removed", () => {
    const redirected = expectedPath("AGENT_METRICS_CODEBUDDY_HOME");
    delete process.env.AGENT_METRICS_CODEBUDDY_HOME;
    expectOutsideFixtureRoot(resolveCodebuddyHome());
    process.env.AGENT_METRICS_CODEBUDDY_HOME = redirected;
  });

  it("falls back outside the fixture root when a directly-resolved Cursor override is removed", () => {
    const cases: Array<{
      name: SourceEnvVarName;
      resolve: () => string;
    }> = [
      {
        name: "AGENT_METRICS_CURSOR_TRACKING_DB_PATH",
        resolve: () => resolveCursorSourcePaths().trackingDbPath
      },
      {
        name: "AGENT_METRICS_CURSOR_WORKSPACE_STORAGE_ROOT",
        resolve: () => resolveCursorSourcePaths().workspaceStorageRoot
      },
      {
        name: "AGENT_METRICS_CURSOR_STORAGE_JSON_PATH",
        resolve: () => resolveCursorSourcePaths().storageJsonPath
      },
      {
        name: "AGENT_METRICS_CURSOR_PROJECTS_ROOT",
        resolve: () => resolveCursorSourcePaths().cursorProjectsRoot
      }
    ];

    for (const { name, resolve } of cases) {
      const redirected = expectedPath(name);
      delete process.env[name];
      expectOutsideFixtureRoot(resolve());
      process.env[name] = redirected;
    }
  });

  it("derives Cursor global storage from the isolated storage JSON when no direct override exists", () => {
    delete process.env.AGENT_METRICS_CURSOR_GLOBAL_STORAGE_DB_PATH;
    expectInsideFixtureRoot(resolveCursorSourcePaths().globalStorageDbPath);

    delete process.env.AGENT_METRICS_CURSOR_STORAGE_JSON_PATH;
    expectOutsideFixtureRoot(resolveCursorSourcePaths().globalStorageDbPath);
  });
});
