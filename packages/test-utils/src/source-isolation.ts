// Shared source-path isolation for tests.
//
// Spec: docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-
// widget-refactor-design.md, section 20.1 ("Test Isolation") and Phase 0.
//
// Every source adapter resolves its input path as `inputArg ?? envVar ??
// resolveDefaultX()`, where the default resolver points at real user telemetry
// (e.g. ~/.claude/projects, ~/.zcode/cli/db/db.sqlite, ~/.cursor/...). A test
// that leaves any of these env vars unset can therefore read the developer's
// real local telemetry. This helper sets ALL known source env vars to
// nonexistent paths under one temp root and restores the originals on cleanup,
// so no test resolves a source outside its fixture root.
//
// This package is dev-only (private, no runtime main/files entry) and MUST NOT
// be imported by production source.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SourceEnvVarName =
  // Claude
  | "AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS"
  // OpenCode
  | "AGENT_METRICS_OPENCODE_DB_PATH"
  | "AGENT_METRICS_OPENCODE_MODELS_PATH"
  // ZCode (shares the opencode adapter but has its own env vars)
  | "AGENT_METRICS_ZCODE_DB_PATH"
  | "AGENT_METRICS_ZCODE_MODELS_PATH"
  // MiMo Desktop (shares the opencode adapter but has its own env vars)
  | "AGENT_METRICS_MIMO_DB_PATH"
  | "AGENT_METRICS_MIMO_MODELS_PATH"
  // Kimi Code CLI (~/.kimi-code)
  | "AGENT_METRICS_KIMICODE_HOME"
  // DeepSeek Harness (~/.dsh)
  | "AGENT_METRICS_DSH_HOME"
  // Codex
  | "AGENT_METRICS_CODEX_SESSIONS_ROOT"
  | "AGENT_METRICS_CODEX_LOGS_DB_PATH"
  | "AGENT_METRICS_CODEX_CONFIG_PATH"
  // Cursor
  | "AGENT_METRICS_CURSOR_TRACKING_DB_PATH"
  | "AGENT_METRICS_CURSOR_WORKSPACE_STORAGE_ROOT"
  | "AGENT_METRICS_CURSOR_STORAGE_JSON_PATH"
  | "AGENT_METRICS_CURSOR_GLOBAL_STORAGE_DB_PATH"
  | "AGENT_METRICS_CURSOR_PROJECTS_ROOT";

/**
 * The authoritative, exhaustive list of every source-path environment variable
 * that an adapter reads to locate real telemetry. A test is isolated only when
 * every entry in this list is redirected away from real user data.
 *
 * Keep this in sync with the per-adapter `resolveDefaultX()` helpers and the
 * spec's section 20.1 list. If a new source env var is added to an adapter, it
 * MUST be added here too so the Phase 0 guard test continues to catch leaks.
 */
export const AGENT_METRICS_SOURCE_ENV_VARS: readonly SourceEnvVarName[] = [
  "AGENT_METRICS_CLAUDE_DISCOVERY_ROOTS",
  "AGENT_METRICS_OPENCODE_DB_PATH",
  "AGENT_METRICS_OPENCODE_MODELS_PATH",
  "AGENT_METRICS_ZCODE_DB_PATH",
  "AGENT_METRICS_ZCODE_MODELS_PATH",
  "AGENT_METRICS_MIMO_DB_PATH",
  "AGENT_METRICS_MIMO_MODELS_PATH",
  "AGENT_METRICS_KIMICODE_HOME",
  "AGENT_METRICS_DSH_HOME",
  "AGENT_METRICS_CODEX_SESSIONS_ROOT",
  "AGENT_METRICS_CODEX_LOGS_DB_PATH",
  "AGENT_METRICS_CODEX_CONFIG_PATH",
  "AGENT_METRICS_CURSOR_TRACKING_DB_PATH",
  "AGENT_METRICS_CURSOR_WORKSPACE_STORAGE_ROOT",
  "AGENT_METRICS_CURSOR_STORAGE_JSON_PATH",
  "AGENT_METRICS_CURSOR_GLOBAL_STORAGE_DB_PATH",
  "AGENT_METRICS_CURSOR_PROJECTS_ROOT"
];

/**
 * Maps each source env var to the fixture-relative path used when isolating.
 * Path delimiters are deliberately avoided: each entry is a single nonexistent
 * path. (Claude's discovery roots env var accepts a delimiter-joined list, but a
 * single root is valid input.)
 */
function defaultFixturePath(envVar: SourceEnvVarName, rootDir: string): string {
  // Group by vendor for readability under the temp root.
  const [, vendor, ...rest] = envVar.split("_");
  const kind = rest.join("-").toLowerCase();
  return join(rootDir, `missing-${vendor.toLowerCase()}-${kind}`);
}

export type IsolatedSources = {
  /** Temp root that every redirected source path lives under. */
  rootDir: string;
  /** Snapshot of the env vars applied (env name -> redirected fixture path). */
  env: Record<SourceEnvVarName, string>;
  /**
   * Restore every source env var to its pre-isolation value (including ones
   * that were previously unset). Idempotent.
   */
  cleanup: () => void;
};

export type IsolateSourcesOptions = {
  /**
   * When provided, fixture paths are placed under this directory and it is NOT
   * created or deleted by the helper. By default a fresh mkdtemp temp root is
   * created under the OS tmpdir.
   */
  rootDir?: string;
  /**
   * Override the fixture path for a specific env var. By default every var is
   * redirected to `<rootDir>/missing-<vendor>-<kind>` (a nonexistent path).
   * Pass an absolute path here to point a single source at a real fixture
   * (e.g. a sqlite DB the test created) while keeping all others isolated.
   */
  overrides?: Partial<Record<SourceEnvVarName, string>>;
};

/**
 * Redirect every known source-path env var away from real user telemetry.
 *
 * Call in a `beforeEach` (or at the top of an `it`) and call `cleanup()` in the
 * matching `afterEach`. The helper uses save/restore semantics so any env value
 * the process had before (including unset) is restored exactly, and cleanup is
 * safe to call more than once.
 */
export async function isolateSources(
  options: IsolateSourcesOptions = {}
): Promise<IsolatedSources> {
  const rootDir = options.rootDir ?? (await mkdtemp(join(tmpdir(), "agent-metrics-sources-")));

  const applied: Record<SourceEnvVarName, string> = {} as Record<SourceEnvVarName, string>;
  // Capture originals BEFORE writing so nested/isolated scopes restore correctly.
  const originals: Partial<Record<SourceEnvVarName, string | undefined>> = {};
  let cleanedUp = false;

  for (const name of AGENT_METRICS_SOURCE_ENV_VARS) {
    originals[name] = process.env[name];
    const redirected =
      options.overrides?.[name] ?? defaultFixturePath(name, rootDir);
    process.env[name] = redirected;
    applied[name] = redirected;
  }

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    for (const name of AGENT_METRICS_SOURCE_ENV_VARS) {
      const original = originals[name];
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  };

  return { rootDir, env: applied, cleanup };
}

/**
 * True when `path` is equal to or nested under `root`. Both are compared as
 * absolute, normalized strings; no filesystem access is performed. Used by the
 * Phase 0 guard test to assert every resolved source path stays inside the
 * fixture root.
 */
export function pathIsInsideRoot(path: string, root: string): boolean {
  if (path === root) {
    return true;
  }
  const rootWithSep = root.endsWith("/") || root.endsWith("\\") ? root : root + "/";
  return path.startsWith(rootWithSep) || path.startsWith(root + "\\");
}
