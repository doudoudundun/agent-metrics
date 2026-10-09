import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHILD_LOG_GENERATIONS,
  CHILD_SHUTDOWN_TIMEOUT_MS,
  FAILURE_WINDOW_MS,
  MAX_CHILD_LOG_BYTES,
  MAX_RESTARTS_PER_WINDOW,
  READINESS_TIMEOUT_MS,
  RESTART_DELAYS_MS,
  STABLE_RUN_RESET_MS,
  __setProcessKillGroupForTesting,
  createRuntimeSupervisor,
  defaultForceKillProcessTree,
  sanitizeErrorSummary
} from "./runtime-supervisor.js";

type EventName = "exit" | "error";

type MockChild = {
  readonly pid: number;
  kill: ReturnType<typeof vi.fn>;
  readonly on: ReturnType<typeof vi.fn>;
  emitExit(code?: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: unknown): void;
};

function createMockChild(pid: number): MockChild {
  const listeners = new Map<EventName, Array<(...args: any[]) => void>>();
  let child: MockChild;
  const emit = (event: EventName, ...args: any[]) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };
  child = {
    pid,
    kill: vi.fn((signal: NodeJS.Signals | number) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        emit("exit", null, signal);
      }
      return true;
    }),
    on: vi.fn((event: EventName, listener: (...args: any[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return child;
    }),
    emitExit: (code = 1, signal = null) => emit("exit", code, signal),
    emitError: (error) => emit("error", error)
  };
  return child;
}

function createSupervisor(children: MockChild[], options: Record<string, unknown> = {}) {
  const spawned: MockChild[] = [];
  const spawn = vi.fn(() => {
    const child = children.shift() ?? createMockChild(10_000 + spawned.length);
    spawned.push(child);
    return child;
  });
  // Tests inject a force-kill that delegates to the mock child's `kill`, so the
  // existing SIGTERM→SIGKILL escalation test keeps asserting on `child.kill`.
  // Dedicated platform-branch tests inject their own forceKillProcessTree.
  const forceKillProcessTree = options.forceKillProcessTree ?? ((child: MockChild) => {
    child.kill("SIGKILL");
  });
  const supervisor = createRuntimeSupervisor({
    runtimePaths: {
      dataRoot: "/runtime-data",
      cliEntrypoint: "/bundle/cli/dist/index.js",
      cliWorkingDirectory: "/bundle/cli",
      coreEntrypoint: "/bundle/core/dist/server.js",
      coreWorkingDirectory: "/bundle/core"
    },
    spawn,
    readinessCheck: () => true,
    process: { execPath: "/usr/local/bin/node", env: { PATH: "/usr/bin" } },
    forceKillProcessTree,
    platform: "linux",
    ...options
  });
  return { supervisor, spawn, spawned };
}

describe("runtime supervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the fixed restart policy and keeps child restarts isolated", async () => {
    vi.useFakeTimers();
    const children = [createMockChild(101), createMockChild(202), createMockChild(303), createMockChild(404)];
    const { supervisor, spawn, spawned } = createSupervisor(children);

    await supervisor.start();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(supervisor.getStatus().state).toBe("ready");

    spawned[1].emitExit(12, "SIGTERM");
    expect(supervisor.getStatus().children[1]).toMatchObject({
      name: "parser",
      state: "degraded",
      pid: null,
      restartCount: 0,
      lastExit: { code: 12, signal: "SIGTERM" }
    });
    expect(spawned[0].kill).not.toHaveBeenCalled();
    expect(spawned[2].kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0] - 1);
    expect(spawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4));
    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "ready", restartCount: 1 });
  });

  it("latches one child after the fifth restart in the rolling window", async () => {
    vi.useFakeTimers();
    const initial = [createMockChild(101), createMockChild(202), createMockChild(303)];
    for (let index = 0; index < MAX_RESTARTS_PER_WINDOW; index += 1) {
      initial.push(createMockChild(400 + index));
    }
    const { supervisor, spawn, spawned } = createSupervisor(initial);

    await supervisor.start();
    let parser = spawned[1];
    for (let index = 0; index < MAX_RESTARTS_PER_WINDOW; index += 1) {
      parser.emitExit(1, null);
      await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[Math.min(index, RESTART_DELAYS_MS.length - 1)]);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4 + index));
      parser = spawned[3 + index];
    }

    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "ready", restartCount: 5 });
    parser.emitExit(1, null);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS.at(-1) ?? 30_000);
    expect(spawn).toHaveBeenCalledTimes(8);
    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "degraded", restartCount: 5 });
  });

  it("resets consecutive failures after a stable run and supports explicit recovery", async () => {
    vi.useFakeTimers();
    const initial = [createMockChild(101), createMockChild(202), createMockChild(303), createMockChild(404), createMockChild(505)];
    const { supervisor, spawned } = createSupervisor(initial);

    await supervisor.start();
    spawned[1].emitExit();
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await vi.waitFor(() => expect(spawned).toHaveLength(4));
    await vi.advanceTimersByTimeAsync(STABLE_RUN_RESET_MS);
    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "ready", restartCount: 0 });

    spawned[3].emitExit();
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await vi.waitFor(() => expect(spawned).toHaveLength(5));
    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "ready", restartCount: 1 });
  });

  it("reuses only a healthy external Core and never signals it", async () => {
    const initial = [createMockChild(101), createMockChild(202)];
    const { supervisor, spawn, spawned } = createSupervisor(initial, {
      isExternalRuntimeHealthy: () => true
    });

    await supervisor.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.getStatus().children[2]).toMatchObject({
      name: "core",
      ownership: "external",
      state: "ready",
      pid: null
    });
    await supervisor.stop();
    expect(spawned[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawned[1].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cancels restart timers before intentional shutdown", async () => {
    vi.useFakeTimers();
    const initial = [createMockChild(101), createMockChild(202), createMockChild(303), createMockChild(404)];
    const { supervisor, spawn, spawned } = createSupervisor(initial);

    await supervisor.start();
    spawned[1].emitExit();
    const stopPromise = supervisor.stop();
    await stopPromise;
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(supervisor.getStatus().state).toBe("stopped");
  });

  it("enforces readiness timeout and bounded shutdown", async () => {
    vi.useFakeTimers();
    const initial = [createMockChild(101), createMockChild(202), createMockChild(303)];
    const { supervisor, spawned } = createSupervisor(initial, {
      readinessCheck: (name: "watcher" | "parser" | "core") => name !== "parser"
    });
    const startPromise = supervisor.start();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    await startPromise;
    expect(spawned[1].kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "degraded", errorSummary: "Readiness timeout" });
  });

  it("sanitizes renderer-facing error summaries", () => {
    expect(sanitizeErrorSummary("bad\npath\u0000\t".repeat(100))).not.toMatch(/[\n\t\u0000]/);
    expect(sanitizeErrorSummary("bad\npath\u0000\t")).toBe("bad path");
  });

  it("keeps the failure window bounded", () => {
    expect(FAILURE_WINDOW_MS).toBe(10 * 60_000);
  });

  it("exports the section 18 quantitative policy constants", () => {
    expect(RESTART_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
    expect(STABLE_RUN_RESET_MS).toBe(5 * 60_000);
    expect(READINESS_TIMEOUT_MS).toBe(15_000);
    expect(CHILD_SHUTDOWN_TIMEOUT_MS).toBe(5_000);
    expect(MAX_RESTARTS_PER_WINDOW).toBe(5);
    expect(MAX_CHILD_LOG_BYTES).toBe(5 * 1024 * 1024);
    expect(CHILD_LOG_GENERATIONS).toBe(3);
  });

  it("spawns managed core when external health check rejects the runtime", async () => {
    const children = [createMockChild(101), createMockChild(202), createMockChild(303)];
    const { supervisor, spawn } = createSupervisor(children, {
      isExternalRuntimeHealthy: () => false
    });

    await supervisor.start();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(supervisor.getStatus().children[2]).toMatchObject({
      name: "core",
      ownership: "managed",
      state: "ready"
    });
  });

  it("escalates shutdown to SIGKILL when SIGTERM does not stop the child", async () => {
    vi.useFakeTimers();
    const stubborn = createMockChild(101);
    stubborn.kill = vi.fn((signal: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") {
        stubborn.emitExit(null, "SIGKILL");
      }
      return true;
    });
    const children = [stubborn, createMockChild(202), createMockChild(303)];
    const { supervisor } = createSupervisor(children);

    await supervisor.start();
    const stopPromise = supervisor.stop();
    await vi.advanceTimersByTimeAsync(CHILD_SHUTDOWN_TIMEOUT_MS - 1);
    expect(stubborn.kill).toHaveBeenCalledWith("SIGTERM");
    expect(stubborn.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;
    expect(stubborn.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("clears a latched child on explicit restart", async () => {
    vi.useFakeTimers();
    const initial = [createMockChild(101), createMockChild(202), createMockChild(303)];
    for (let index = 0; index < MAX_RESTARTS_PER_WINDOW; index += 1) {
      initial.push(createMockChild(400 + index));
    }
    const { supervisor, spawn, spawned } = createSupervisor(initial);

    await supervisor.start();
    let parser = spawned[1];
    for (let index = 0; index < MAX_RESTARTS_PER_WINDOW; index += 1) {
      parser.emitExit(1, null);
      await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[Math.min(index, RESTART_DELAYS_MS.length - 1)]);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4 + index));
      parser = spawned[3 + index];
    }
    parser.emitExit(1, null);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS.at(-1) ?? 30_000);
    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "degraded", restartCount: 5 });

    const restartSpawnCount = spawn.mock.calls.length;
    await supervisor.restart("parser");
    expect(spawn.mock.calls.length).toBeGreaterThan(restartSpawnCount);
    expect(supervisor.getStatus().children[1]).toMatchObject({ state: "ready", restartCount: 0 });
  });

  it("keeps only one restart timer per child", async () => {
    vi.useFakeTimers();
    const children = [createMockChild(101), createMockChild(202), createMockChild(303), createMockChild(404)];
    const { supervisor, spawn, spawned } = createSupervisor(children);

    await supervisor.start();
    spawned[1].emitExit(1, null);
    spawned[1].emitExit(1, null);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4));
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it("indexes restart delay by consecutive failure count", async () => {
    vi.useFakeTimers();
    const initial = [
      createMockChild(101),
      createMockChild(202),
      createMockChild(303),
      createMockChild(404),
      createMockChild(505)
    ];
    const { supervisor, spawn, spawned } = createSupervisor(initial);

    await supervisor.start();
    spawned[1].emitExit(1, null);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4));

    spawned[3].emitExit(1, null);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[1] - 1);
    expect(spawn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(5));
  });

  it("section 18: Windows shutdown escalation force-kills the process tree via taskkill /T /F", async () => {
    vi.useFakeTimers();
    const stubborn = createMockChild(777);
    // Stubborn child never exits on SIGTERM; the force-kill path must run.
    stubborn.kill = vi.fn(() => true);
    const taskkillCalls: string[] = [];
    // Force-kill implementation that records the taskkill command (the /T walks
    // the descendant tree, /F force-terminates) and then marks the child exited.
    const forceKillProcessTree = (child: MockChild, pid: number | undefined) => {
      taskkillCalls.push(`taskkill /T /F /PID ${pid}`);
      child.emitExit(null, "SIGKILL");
    };
    // Watcher (index 0) is the stubborn child so its escalation surfaces in
    // children[0]; parser (202) and core (303) cooperate normally.
    const { supervisor } = createSupervisor([stubborn, createMockChild(202), createMockChild(303)], {
      forceKillProcessTree,
      platform: "win32"
    });

    await supervisor.start();
    const stopPromise = supervisor.stop();
    await vi.advanceTimersByTimeAsync(CHILD_SHUTDOWN_TIMEOUT_MS);
    await stopPromise;

    expect(taskkillCalls).toContain("taskkill /T /F /PID 777");
    // The escalation is recorded in the renderer-facing RuntimeStatus summary.
    const watcher = supervisor.getStatus().children[0];
    expect(watcher.errorSummary ?? "").toMatch(/Force-killed/);
  });

  it("section 18: POSIX shutdown escalation targets the process group (negative PID)", async () => {
    vi.useFakeTimers();
    const stubborn = createMockChild(999);
    stubborn.kill = vi.fn(() => true);
    // The default force-kill implementation invokes processKillGroup(pid, signal),
    // which internally negates the PID to address the process group. The test
    // stub records the raw pid argument the implementation handed off.
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    __setProcessKillGroupForTesting((pid, signal) => {
      groupSignals.push({ pid, signal });
      stubborn.emitExit(null, "SIGKILL");
    });
    try {
      const { supervisor } = createSupervisor(
        [stubborn, createMockChild(202), createMockChild(303)],
        { forceKillProcessTree: defaultForceKillProcessTree, platform: "linux" }
      );

      await supervisor.start();
      const stopPromise = supervisor.stop();
      await vi.advanceTimersByTimeAsync(CHILD_SHUTDOWN_TIMEOUT_MS);
      await stopPromise;

      // The implementation handed the child's PID to the process-group killer;
      // that helper negates it (`process.kill(-pgid)`) per spec §18's POSIX
      // process-group SIGKILL equivalent of Windows `taskkill /T /F`.
      expect(groupSignals).toContainEqual({ pid: 999, signal: "SIGKILL" });
    } finally {
      __setProcessKillGroupForTesting((pgid, signal) => {
        (globalThis.process.kill as (pid: number, signal?: NodeJS.Signals) => boolean)(-pgid, signal);
      });
    }
  });

  it("section 18: marks runtime degraded when child log rotation fails", async () => {
    // The supervisor writes child stderr via queued appendFile under a real
    // dataRoot. Point dataRoot at an unwritable path so rotation/append fails,
    // then emit stderr data through the mock child to trigger the write path.
    type StreamMock = { on: ReturnType<typeof vi.fn> };
    const makeStream = (): StreamMock & { emitData(chunk: Buffer): void } => {
      const listeners = new Map<string, Array<(chunk: unknown) => void>>();
      return {
        on: vi.fn((event: string, listener: (chunk: unknown) => void) => {
          const existing = listeners.get(event) ?? [];
          existing.push(listener);
          listeners.set(event, existing);
        }),
        emitData(chunk: Buffer) {
          for (const listener of listeners.get("data") ?? []) {
            listener(chunk);
          }
        }
      };
    };
    const stderr = makeStream();
    const child = createMockChild(202) as MockChild & { stderr?: StreamMock };
    child.stderr = stderr;
    // Map child 202 to the parser slot (index 1) so we assert on children[1].
    const watcher = createMockChild(101);
    const core = createMockChild(303);
    const spawn = vi.fn(() => {
      // First call → watcher, second → parser (with stderr), third → core.
      return [watcher, child, core][spawn.mock.calls.length - 1];
    });
    const supervisor = createRuntimeSupervisor({
      runtimePaths: {
        dataRoot: "Z:/cannot-write-here/nonexistent-root",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      readinessCheck: () => true,
      process: { execPath: "/usr/local/bin/node", env: { PATH: "/usr/bin" } },
      platform: "linux",
      forceKillProcessTree: (c: MockChild) => c.kill("SIGKILL")
    });

    await supervisor.start();
    // Emit a large stderr chunk that exceeds MAX_CHILD_LOG_BYTES to force the
    // rotation + append path against the unwritable dataRoot.
    stderr.emitData(Buffer.from(`${"x".repeat(MAX_CHILD_LOG_BYTES + 1)}\n`));
    // Allow the async log queue to settle before asserting the degradation.
    await vi.waitFor(() => {
      expect(supervisor.getStatus().children[1].errorSummary ?? "").toMatch(/Log write failed/);
    });
    expect(supervisor.getStatus().children[1].state).toBe("degraded");
  });
});
