import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { execSync, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { ChildName, ChildRuntimeStatus } from "@agent-metrics/contracts";
import type { DesktopRuntimePaths } from "../runtime-paths.js";

export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const FAILURE_WINDOW_MS = 10 * 60_000;
export const STABLE_RUN_RESET_MS = 5 * 60_000;
export const READINESS_TIMEOUT_MS = 15_000;
/** Core may run a one-shot Phase-2 SQLite backfill on first open (can exceed 15s). */
export const CORE_READINESS_TIMEOUT_MS = 180_000;
export const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;
export const MAX_RESTARTS_PER_WINDOW = 5;
export const MAX_CHILD_LOG_BYTES = 5 * 1024 * 1024;
export const CHILD_LOG_GENERATIONS = 3;

export type ForceKillProcessTree = (
  child: SpawnedChild,
  pid: number | undefined,
  platform: NodeJS.Platform
) => void;

/**
 * Spec section 18: force-terminate the owned process tree. Windows uses
 * `taskkill /T /F /PID` (the `/T` flag walks the child tree); POSIX targets use
 * a process-group SIGKILL — children are spawned `detached: true` so their PID
 * is the group leader, and `process.kill(-pgid, "SIGKILL")` reaches the whole
 * group. Both paths fall back to a direct `child.kill("SIGKILL")` when the PID
 * is unknown.
 */
export const defaultForceKillProcessTree: ForceKillProcessTree = (child, pid, platform) => {
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (platform === "win32") {
    // /T walks descendants; /F force-terminates. execSync throws on nonzero
    // exit (e.g. already-dead PID); swallow because the escalation is
    // best-effort after SIGTERM already had its window. Synchronous so the
    // process tree is gone before we mark the child stopped.
    try {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  try {
    processKillGroup(pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

// Indirection so tests can stub process.kill for the POSIX group path without
// monkey-patching the global.
let processKillGroup = (pgid: number, signal: NodeJS.Signals): void => {
  (globalThis.process.kill as (pid: number, signal?: NodeJS.Signals) => boolean)(-pgid, signal);
};

export function __setProcessKillGroupForTesting(fn: (pgid: number, signal: NodeJS.Signals) => void): void {
  processKillGroup = fn;
}

type SupervisorState = "starting" | "ready" | "degraded" | "stopped";
type Ownership = "managed" | "external" | "none";
type StreamName = "stdout" | "stderr";

type ChildStream = {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
};

type SpawnedChild = {
  readonly pid?: number;
  readonly stdout?: ChildStream | null;
  readonly stderr?: ChildStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): SpawnedChild;
  on(event: "error", listener: (error: unknown) => void): SpawnedChild;
};

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => SpawnedChild;

type ProcessLike = {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath: string;
};

type RuntimeHealthCheck = () => boolean | Promise<boolean>;
type ReadinessCheck = (name: ChildName) => boolean | Promise<boolean>;

type Tracker = {
  ownership: Ownership;
  failureTimestamps: number[];
  consecutiveFailures: number;
  latched: boolean;
  lastExit: ChildRuntimeStatus["lastExit"];
  errorSummary: string | null;
  stableTimer: NodeJS.Timeout | null;
  forceKillRequested: boolean;
  logWriteFailed: boolean;
};

type ManagedChild = {
  readonly name: ChildName;
  readonly child: SpawnedChild;
  readonly tracker: Tracker;
  readonly generation: number;
  readonly whenStopped: Promise<void>;
  state: "starting" | "ready" | "degraded" | "stopped";
  intentional: boolean;
  exited: boolean;
  forceKillRequested: boolean;
  resolveStopped(): void;
};

export type RuntimeSupervisorStatus = {
  state: SupervisorState;
  children: ChildRuntimeStatus[];
};

export function sanitizeErrorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Unknown runtime error";
}

export function createRuntimeSupervisor({
  runtimePaths,
  nodeExecutablePath,
  isExternalRuntimeHealthy,
  readinessCheck,
  spawn = nodeSpawn as unknown as SpawnFn,
  process = globalThis.process,
  now = () => Date.now(),
  log = () => undefined,
  forceKillProcessTree = defaultForceKillProcessTree,
  platform = globalThis.process.platform,
  localAccessToken
}: {
  runtimePaths: Pick<
    DesktopRuntimePaths,
    "dataRoot" | "cliEntrypoint" | "cliWorkingDirectory" | "coreEntrypoint" | "coreWorkingDirectory"
  >;
  nodeExecutablePath?: string;
  isExternalRuntimeHealthy?: RuntimeHealthCheck;
  readinessCheck?: ReadinessCheck;
  spawn?: SpawnFn;
  process?: ProcessLike;
  now?: () => number;
  log?: (message: string) => void;
  forceKillProcessTree?: ForceKillProcessTree;
  platform?: NodeJS.Platform;
  localAccessToken?: string;
}) {
  const trackers = new Map<ChildName, Tracker>();
  const children = new Map<ChildName, ManagedChild>();
  const restartTimers = new Map<ChildName, NodeJS.Timeout>();
  const logQueues = new Map<ChildName, Promise<void>>();
  const logSizes = new Map<ChildName, number>();
  let state: SupervisorState = "stopped";
  let stopping = false;
  let lifecycleOperation = Promise.resolve();
  let generation = 0;

  function trackerFor(name: ChildName): Tracker {
    const existing = trackers.get(name);
    if (existing) {
      return existing;
    }
    const created: Tracker = {
      ownership: "none",
      failureTimestamps: [],
      consecutiveFailures: 0,
      latched: false,
      lastExit: null,
      errorSummary: null,
      stableTimer: null,
      forceKillRequested: false,
      logWriteFailed: false
    };
    trackers.set(name, created);
    return created;
  }

  function clearStableTimer(tracker: Tracker): void {
    if (tracker.stableTimer !== null) {
      clearTimeout(tracker.stableTimer);
      tracker.stableTimer = null;
    }
  }

  function clearRestartTimer(name: ChildName): void {
    const timer = restartTimers.get(name);
    if (timer !== undefined) {
      clearTimeout(timer);
      restartTimers.delete(name);
    }
  }

  function clearAllRestartTimers(): void {
    for (const name of restartTimers.keys()) {
      clearRestartTimer(name);
    }
  }

  function resetFailureState(tracker: Tracker, clearExit = true): void {
    clearStableTimer(tracker);
    tracker.failureTimestamps = [];
    tracker.consecutiveFailures = 0;
    tracker.latched = false;
    tracker.forceKillRequested = false;
    tracker.logWriteFailed = false;
    if (clearExit) {
      tracker.lastExit = null;
      tracker.errorSummary = null;
    }
  }

  function trimFailureWindow(tracker: Tracker): void {
    const threshold = now() - FAILURE_WINDOW_MS;
    tracker.failureTimestamps = tracker.failureTimestamps.filter((at) => at >= threshold);
  }

  function runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycleOperation.then(operation, operation);
    lifecycleOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  function joinDataPath(rootPath: string, ...segments: string[]): string {
    if (rootPath.includes("/") && !rootPath.includes("\\")) {
      return posix.join(rootPath, ...segments);
    }
    if (rootPath.includes("\\") && !rootPath.includes("/")) {
      return win32.join(rootPath, ...segments);
    }
    return join(rootPath, ...segments);
  }

  function childArgs(name: ChildName): { cwd: string; args: string[]; env?: NodeJS.ProcessEnv } {
    if (name === "watcher") {
      return {
        cwd: runtimePaths.cliWorkingDirectory,
        args: [
          runtimePaths.cliEntrypoint,
          "hooks",
          "watch",
          "--scope",
          "global",
          "--repo-root",
          runtimePaths.dataRoot,
          "--cli-path",
          runtimePaths.cliEntrypoint
        ]
      };
    }
    if (name === "parser") {
      return {
        cwd: runtimePaths.cliWorkingDirectory,
        args: [runtimePaths.cliEntrypoint, "hooks", "parse", "--follow", "--repo-root", runtimePaths.dataRoot]
      };
    }
    return {
      cwd: runtimePaths.coreWorkingDirectory,
      args: [runtimePaths.coreEntrypoint],
      env: {
        AGENT_METRICS_CORE_PORT: process.env?.AGENT_METRICS_CORE_PORT ?? "45183",
        AGENT_METRICS_DB_PATH: joinDataPath(runtimePaths.dataRoot, "data", "sqlite", "metrics.sqlite"),
        AGENT_METRICS_EVENT_LOG_PATH: joinDataPath(runtimePaths.dataRoot, "data", "events", "events.jsonl"),
        AGENT_METRICS_REPO_ROOT: runtimePaths.dataRoot,
        ...(localAccessToken || process.env?.AGENT_METRICS_LOCAL_TOKEN
          ? { AGENT_METRICS_LOCAL_TOKEN: localAccessToken ?? process.env?.AGENT_METRICS_LOCAL_TOKEN }
          : {})
      }
    };
  }

  function attachOutput(name: ChildName, streamName: StreamName, stream: ChildStream | null | undefined): void {
    if (!stream) {
      return;
    }
    stream.on("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      queueChildLog(name, `[${name}][${streamName}] ${text}`);
    });
    stream.on("error", (error) => {
      log(`[${name}][${streamName}] stream error: ${sanitizeErrorSummary(error)}`);
    });
  }

  function queueChildLog(name: ChildName, text: string): void {
    const previous = logQueues.get(name) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => writeChildLog(name, text));
    logQueues.set(name, next);
    void next.catch((error) => {
      // Spec §18: log write failure retains stderr diagnostics where possible and
      // marks runtime degraded rather than discarding all further output.
      markLogWriteFailed(name, error);
    });
  }

  function markLogWriteFailed(name: ChildName, error: unknown): void {
    const tracker = trackerFor(name);
    const summary = sanitizeErrorSummary(error);
    tracker.errorSummary = tracker.errorSummary ?? `Log write failed: ${summary}`;
    tracker.logWriteFailed = true;
    log(`[${name}][stderr] log write failed: ${summary}`);
    refreshState();
  }

  async function writeChildLog(name: ChildName, text: string): Promise<void> {
    const directory = joinDataPath(runtimePaths.dataRoot, "logs", "runtime");
    const filePath = join(directory, `${name}.log`);
    await mkdir(directory, { recursive: true });
    let size = logSizes.get(name);
    if (size === undefined) {
      size = await stat(filePath).then((result) => result.size).catch(() => 0);
    }
    const data = Buffer.from(text);
    if (size + data.byteLength > MAX_CHILD_LOG_BYTES) {
      // Spec §18: rotation failure MUST mark runtime degraded rather than
      // silently continue. Rotation errors propagate to markLogWriteFailed via
      // the queue's rejection handler; they do NOT reset `size`, so the next
      // append retries rotation on the next chunk.
      await rotateChildLog(filePath);
      size = 0;
    }
    await appendFile(filePath, data);
    logSizes.set(name, size + data.byteLength);
  }

  async function rotateChildLog(filePath: string): Promise<void> {
    for (let index = CHILD_LOG_GENERATIONS; index >= 1; index -= 1) {
      const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const target = `${filePath}.${index}`;
      // `rm` failing on a missing target is benign (the generation may not exist
      // yet); `rename` failing on a missing source is also benign. We only throw
      // when the destination cannot be written — that surfaces as a rotation
      // failure and marks the runtime degraded.
      try {
        await rm(target, { force: true });
      } catch {
        // Best-effort cleanup of the target slot; continue to rename.
      }
      try {
        await rename(source, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        // ENOENT: source generation never existed yet (first rotation). Not a failure.
        if (code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  function defaultReadiness(name: ChildName): ReadinessCheck {
    if (readinessCheck) {
      return readinessCheck;
    }
    if (name === "core" && isExternalRuntimeHealthy) {
      return () => isExternalRuntimeHealthy();
    }
    return () => true;
  }

  function startStableTimer(record: ManagedChild): void {
    clearStableTimer(record.tracker);
    record.tracker.stableTimer = setTimeout(() => {
      if (children.get(record.name) !== record || record.exited || record.state !== "ready") {
        return;
      }
      resetFailureState(record.tracker, false);
    }, STABLE_RUN_RESET_MS);
  }

  function markStopped(record: ManagedChild): void {
    if (record.exited) {
      return;
    }
    record.exited = true;
    record.state = "stopped";
    record.resolveStopped();
  }

  function markUnexpectedExit(
    record: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: unknown
  ): void {
    if (record.exited || children.get(record.name) !== record) {
      return;
    }
    clearStableTimer(record.tracker);
    record.exited = true;
    record.state = record.intentional || stopping ? "stopped" : "degraded";
    record.resolveStopped();
    if (record.intentional || stopping) {
      refreshState();
      return;
    }
    record.tracker.lastExit = {
      code,
      signal: signal ? String(signal) : null,
      at: new Date(now()).toISOString()
    };
    record.tracker.errorSummary = error ? sanitizeErrorSummary(error) : null;
    record.tracker.consecutiveFailures += 1;
    state = "degraded";
    scheduleRestart(record.name, record);
  }

  function launchChild(name: ChildName, automatic: boolean): ManagedChild {
    const tracker = trackerFor(name);
    const command = nodeExecutablePath ?? process.execPath;
    const useElectronAsNode = nodeExecutablePath === undefined;
    const config = childArgs(name);
    if (automatic) {
      trimFailureWindow(tracker);
      tracker.failureTimestamps.push(now());
    }
    const child = spawn(command, config.args, {
      cwd: config.cwd,
      env: {
        ...(process.env ?? {}),
        ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        ...(config.env ?? {})
      },
      // Spec §18: on POSIX the force-kill path targets the whole process group
      // via `process.kill(-pgid, "SIGKILL")`, so children must be their own group
      // leader. Windows ignores this and uses `taskkill /T /F` for tree kill.
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const record = createRecord(name, child, tracker);
    children.set(name, record);
    tracker.ownership = "managed";
    attachOutput(name, "stdout", child.stdout);
    attachOutput(name, "stderr", child.stderr);
    child.on("exit", (code, signal) => markUnexpectedExit(record, code, signal));
    child.on("error", (error) => markUnexpectedExit(record, null, null, error));
    log(`[${name}] ${automatic ? "automatic restart" : "launch"} pid=${child.pid ?? "unknown"}`);
    return record;
  }

  function createRecord(name: ChildName, child: SpawnedChild, tracker: Tracker): ManagedChild {
    let resolveStopped: () => void = () => undefined;
    const whenStopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    return {
      name,
      child,
      tracker,
      generation: ++generation,
      whenStopped,
      state: "starting",
      intentional: false,
      exited: false,
      forceKillRequested: false,
      resolveStopped
    };
  }

  async function stopChild(record: ManagedChild): Promise<void> {
    if (record.exited) {
      return;
    }
    record.intentional = true;
    record.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (!record.exited && !record.forceKillRequested) {
          record.forceKillRequested = true;
          // Spec §18: force-terminate the owned process tree (Windows
          // `taskkill /T /F`; POSIX process-group SIGKILL). Record the
          // escalation so RuntimeStatus surfaces it.
          record.tracker.forceKillRequested = true;
          forceKillProcessTree(record.child, record.child.pid, platform);
          markStopped(record);
        }
        finish();
      }, CHILD_SHUTDOWN_TIMEOUT_MS);
      void record.whenStopped.then(finish);
    });
  }

  async function waitForReady(record: ManagedChild): Promise<boolean> {
    const check = defaultReadiness(record.name);
    const deadline =
      now() + (record.name === "core" ? CORE_READINESS_TIMEOUT_MS : READINESS_TIMEOUT_MS);
    while (!record.exited && children.get(record.name) === record) {
      let ready = false;
      try {
        ready = await check(record.name);
      } catch (error) {
        record.tracker.errorSummary = sanitizeErrorSummary(error);
      }
      if (ready) {
        record.state = "ready";
        record.tracker.errorSummary = null;
        startStableTimer(record);
        refreshState();
        return true;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        record.tracker.errorSummary = "Readiness timeout";
        await stopChild(record);
        record.tracker.consecutiveFailures += 1;
        record.state = "degraded";
        scheduleRestart(record.name, record);
        refreshState();
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    return false;
  }

  function scheduleRestart(name: ChildName, record: ManagedChild): void {
    if (stopping || restartTimers.has(name) || record.tracker.latched || trackerFor(name).ownership === "external") {
      return;
    }
    trimFailureWindow(record.tracker);
    if (record.tracker.failureTimestamps.length >= MAX_RESTARTS_PER_WINDOW) {
      record.tracker.latched = true;
      refreshState();
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(Math.max(record.tracker.consecutiveFailures - 1, 0), RESTART_DELAYS_MS.length - 1)];
    const timer = setTimeout(() => {
      restartTimers.delete(name);
      if (stopping || children.get(name) !== record || record.tracker.latched) {
        return;
      }
      trimFailureWindow(record.tracker);
      if (record.tracker.failureTimestamps.length >= MAX_RESTARTS_PER_WINDOW) {
        record.tracker.latched = true;
        refreshState();
        return;
      }
      try {
        const replacement = launchChild(name, true);
        void waitForReady(replacement).then(() => refreshState());
      } catch (error) {
        record.tracker.errorSummary = sanitizeErrorSummary(error);
        record.tracker.consecutiveFailures += 1;
        scheduleRestart(name, record);
      }
      refreshState();
    }, delay);
    restartTimers.set(name, timer);
  }

  async function startInternal(): Promise<RuntimeSupervisorStatus> {
    if (state === "ready" && [...children.values()].every((child) => !child.exited && child.state === "ready")) {
      return getStatus();
    }
    stopping = false;
    if (state === "stopped") {
      for (const tracker of trackers.values()) {
        resetFailureState(tracker);
      }
    }
    state = "starting";
    const externalHealthy = isExternalRuntimeHealthy
      ? await Promise.resolve(isExternalRuntimeHealthy()).catch(() => false)
      : false;
    const coreTracker = trackerFor("core");
    if (externalHealthy && !children.has("core")) {
      coreTracker.ownership = "external";
      coreTracker.errorSummary = null;
    } else if (!externalHealthy && coreTracker.ownership === "external") {
      coreTracker.ownership = "none";
    }
    const pending: ManagedChild[] = [];
    for (const name of ["watcher", "parser", "core"] as const) {
      if (name === "core" && coreTracker.ownership === "external") {
        continue;
      }
      const existing = children.get(name);
      if (existing && !existing.exited) {
        continue;
      }
      try {
        pending.push(launchChild(name, false));
      } catch (error) {
        const tracker = trackerFor(name);
        tracker.ownership = "managed";
        tracker.errorSummary = sanitizeErrorSummary(error);
        tracker.consecutiveFailures += 1;
      }
    }
    await Promise.all(pending.map((record) => waitForReady(record)));
    refreshState();
    return getStatus();
  }

  async function restartInternal(name: ChildName): Promise<RuntimeSupervisorStatus> {
    stopping = false;
    clearRestartTimer(name);
    const tracker = trackerFor(name);
    resetFailureState(tracker);
    const existing = children.get(name);
    if (existing && !existing.exited) {
      await stopChild(existing);
    }
    children.delete(name);
    if (name === "core") {
      const externalHealthy = isExternalRuntimeHealthy
        ? await Promise.resolve(isExternalRuntimeHealthy()).catch(() => false)
        : false;
      if (externalHealthy) {
        tracker.ownership = "external";
        refreshState();
        return getStatus();
      }
    }
    tracker.ownership = "managed";
    state = "starting";
    try {
      const record = launchChild(name, false);
      await waitForReady(record);
    } catch (error) {
      tracker.errorSummary = sanitizeErrorSummary(error);
      tracker.consecutiveFailures += 1;
    }
    refreshState();
    return getStatus();
  }

  async function stopInternal(): Promise<RuntimeSupervisorStatus> {
    stopping = true;
    clearAllRestartTimers();
    state = "stopped";
    await Promise.all([...children.values()].map((record) => stopChild(record)));
    for (const tracker of trackers.values()) {
      clearStableTimer(tracker);
      if (tracker.ownership === "external") {
        tracker.ownership = "none";
      }
    }
    refreshState();
    return getStatus();
  }

  function childStatus(name: ChildName): ChildRuntimeStatus {
    const tracker = trackerFor(name);
    const record = children.get(name);
    if (tracker.ownership === "external") {
      return {
        name,
        ownership: "external",
        state: "ready",
        pid: null,
        restartCount: tracker.failureTimestamps.length,
        lastExit: tracker.lastExit,
        errorSummary: tracker.errorSummary
      };
    }
    if (!record) {
      return {
        name,
        ownership: tracker.ownership,
        state: "stopped",
        pid: null,
        restartCount: tracker.failureTimestamps.length,
        lastExit: tracker.lastExit,
        errorSummary: tracker.errorSummary
      };
    }
    // Spec §18: a log-rotation/write failure marks the runtime degraded. The
    // child itself may still be healthy, but the supervisor surface must reflect
    // the logging degradation so RuntimeStatus does not report a clean runtime.
    const recordState =
      (record.exited && tracker.errorSummary) || tracker.logWriteFailed
        ? "degraded"
        : record.state;
    return {
      name,
      ownership: tracker.ownership,
      state: recordState,
      pid: record.exited ? null : record.child.pid ?? null,
      restartCount: tracker.failureTimestamps.length,
      lastExit: tracker.lastExit,
      // Spec §18: surface the graceful→forced escalation in the renderer-facing
      // summary so RuntimeStatus records it without leaking process internals.
      errorSummary: tracker.forceKillRequested
        ? tracker.errorSummary ?? "Force-killed after graceful shutdown timeout"
        : tracker.errorSummary
    };
  }

  function refreshState(): void {
    const statuses = (["watcher", "parser", "core"] as const).map(childStatus);
    if (stopping || statuses.every((child) => child.state === "stopped" && child.ownership !== "external")) {
      state = "stopped";
      return;
    }
    if (statuses.some((child) => child.state === "degraded")) {
      state = "degraded";
      return;
    }
    if (statuses.some((child) => child.state === "starting")) {
      state = "starting";
      return;
    }
    state = statuses.every((child) => child.state === "ready") ? "ready" : "degraded";
  }

  function getStatus(): RuntimeSupervisorStatus {
    refreshState();
    return {
      state,
      children: (["watcher", "parser", "core"] as const).map(childStatus)
    };
  }

  const api = {
    start(): Promise<RuntimeSupervisorStatus> {
      return runLifecycleOperation(startInternal);
    },
    restart(name: ChildName): Promise<RuntimeSupervisorStatus> {
      return runLifecycleOperation(() => restartInternal(name));
    },
    stop(): Promise<RuntimeSupervisorStatus> {
      return runLifecycleOperation(stopInternal);
    },
    getStatus
  };

  return api;
}
