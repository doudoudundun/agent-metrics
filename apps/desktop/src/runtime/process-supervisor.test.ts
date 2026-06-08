import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHILD_SHUTDOWN_TIMEOUT_MS,
  createProcessSupervisor
} from "./process-supervisor.js";

type MockChild = {
  readonly pid?: number;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

function createMockChild(pid?: number): MockChild & {
  emit(event: "exit" | "error"): void;
  readonly killRequested: boolean;
} {
  const listeners = new Map<"exit" | "error", Array<() => void>>();
  let killRequested = false;

  return {
    pid,
    kill: vi.fn(() => {
      killRequested = true;
      return true;
    }),
    on: vi.fn((event: "exit" | "error", listener: () => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return undefined;
    }),
    get killRequested() {
      return killRequested;
    },
    emit(event: "exit" | "error") {
      for (const listener of listeners.get(event) ?? []) {
        listener();
      }
    }
  };
}

describe("process supervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts watcher, parser, and core with Electron-safe repo-root based entrypoints", async () => {
    const spawn = vi.fn(() => createMockChild());
    const env = {
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "0",
      CUSTOM_FLAG: "present"
    };

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics", env }
    });

    await supervisor.start();

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics",
      [
        "/bundle/cli/dist/index.js",
        "hooks",
        "watch",
        "--scope",
        "global",
        "--repo-root",
        "/runtime-data",
        "--cli-path",
        "/bundle/cli/dist/index.js"
      ],
      expect.objectContaining({
        cwd: "/bundle/cli",
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: "1"
        },
        stdio: "ignore"
      })
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics",
      [
        "/bundle/cli/dist/index.js",
        "hooks",
        "parse",
        "--follow",
        "--repo-root",
        "/runtime-data"
      ],
      expect.objectContaining({
        cwd: "/bundle/cli",
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: "1"
        },
        stdio: "ignore"
      })
    );
    expect(spawn).toHaveBeenNthCalledWith(
      3,
      "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics",
      ["/bundle/core/dist/server.js"],
      expect.objectContaining({
        cwd: "/bundle/core",
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: "1",
          AGENT_METRICS_DB_PATH: "/runtime-data/data/sqlite/metrics.sqlite",
          AGENT_METRICS_EVENT_LOG_PATH: "/runtime-data/data/events/events.jsonl",
          AGENT_METRICS_REPO_ROOT: "/runtime-data"
        },
        stdio: "ignore"
      })
    );
    expect(spawn).not.toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          AGENT_METRICS_CORE_TRANSCRIPT_SYNC: "0"
        })
      })
    );
    expect(supervisor.getStatus()).toEqual({
      state: "running",
      children: [
        { name: "watcher", state: "running", pid: undefined },
        { name: "parser", state: "running", pid: undefined },
        { name: "core", state: "running", pid: undefined }
      ]
    });
  });

  it("uses an explicit node runtime without Electron compatibility shims", async () => {
    const spawn = vi.fn(() => createMockChild());
    const env = {
      PATH: "/usr/bin",
      CUSTOM_FLAG: "present"
    };

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      nodeExecutablePath: "/usr/local/bin/node",
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics", env }
    });

    await supervisor.start();

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "/usr/local/bin/node",
      [
        "/bundle/cli/dist/index.js",
        "hooks",
        "watch",
        "--scope",
        "global",
        "--repo-root",
        "/runtime-data",
        "--cli-path",
        "/bundle/cli/dist/index.js"
      ],
      expect.objectContaining({
        cwd: "/bundle/cli",
        env,
        stdio: "ignore"
      })
    );
  });

  it("reuses an already healthy external runtime chain without spawning children", async () => {
    const spawn = vi.fn();
    const isExternalRuntimeHealthy = vi.fn(async () => true);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      isExternalRuntimeHealthy,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await expect(supervisor.start()).resolves.toEqual({
      state: "running",
      children: []
    });
    expect(isExternalRuntimeHealthy).toHaveBeenCalledExactlyOnceWith();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rolls back already-started children when a later spawn throws and allows retry", async () => {
    const watcher = createMockChild(101);
    const parser = createMockChild(202);
    const core = createMockChild(303);
    const spawn = vi
      .fn()
      .mockReturnValueOnce(watcher)
      .mockImplementationOnce(() => {
        throw new Error("parser failed to spawn");
      })
      .mockReturnValueOnce(watcher)
      .mockReturnValueOnce(parser)
      .mockReturnValueOnce(core);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    const startPromise = supervisor.start();
    await Promise.resolve();

    expect(watcher.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(watcher.killRequested).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);

    watcher.emit("exit");

    await expect(startPromise).rejects.toThrow("parser failed to spawn");
    expect(supervisor.getStatus()).toEqual({
      state: "stopped",
      children: []
    });

    await expect(supervisor.start()).resolves.toEqual({
      state: "running",
      children: [
        { name: "watcher", state: "running", pid: 101 },
        { name: "parser", state: "running", pid: 202 },
        { name: "core", state: "running", pid: 303 }
      ]
    });
    expect(spawn).toHaveBeenCalledTimes(5);
  });

  it("updates child status when a managed process exits", async () => {
    const watcher = createMockChild(101);
    const parser = createMockChild(202);
    const core = createMockChild(303);
    const spawn = vi
      .fn()
      .mockReturnValueOnce(watcher)
      .mockReturnValueOnce(parser)
      .mockReturnValueOnce(core);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await supervisor.start();
    parser.emit("exit");

    expect(supervisor.getStatus()).toEqual({
      state: "degraded",
      children: [
        { name: "watcher", state: "running", pid: 101 },
        { name: "parser", state: "stopped", pid: 202 },
        { name: "core", state: "running", pid: 303 }
      ]
    });
  });

  it("recovers from a degraded runtime chain by starting fresh children", async () => {
    const firstWatcher = createMockChild(101);
    const firstParser = createMockChild(202);
    const firstCore = createMockChild(303);
    const secondWatcher = createMockChild(404);
    const secondParser = createMockChild(505);
    const secondCore = createMockChild(606);
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(firstParser)
      .mockReturnValueOnce(firstCore)
      .mockReturnValueOnce(secondWatcher)
      .mockReturnValueOnce(secondParser)
      .mockReturnValueOnce(secondCore);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await supervisor.start();
    firstParser.emit("error");

    expect(supervisor.getStatus()).toEqual({
      state: "degraded",
      children: [
        { name: "watcher", state: "running", pid: 101 },
        { name: "parser", state: "stopped", pid: 202 },
        { name: "core", state: "running", pid: 303 }
      ]
    });

    const restartPromise = supervisor.start();
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(firstWatcher.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(firstCore.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(secondWatcher.killRequested).toBe(false);

    firstWatcher.emit("exit");
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(3);

    firstCore.emit("exit");

    await expect(restartPromise).resolves.toEqual({
      state: "running",
      children: [
        { name: "watcher", state: "running", pid: 404 },
        { name: "parser", state: "running", pid: 505 },
        { name: "core", state: "running", pid: 606 }
      ]
    });
    expect(firstParser.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(6);
  });

  it("does not relaunch children if stop begins during degraded restart", async () => {
    const firstWatcher = createMockChild(101);
    const firstParser = createMockChild(202);
    const firstCore = createMockChild(303);
    const replacementWatcher = createMockChild(404);
    const replacementParser = createMockChild(505);
    const replacementCore = createMockChild(606);
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(firstParser)
      .mockReturnValueOnce(firstCore)
      .mockReturnValueOnce(replacementWatcher)
      .mockReturnValueOnce(replacementParser)
      .mockReturnValueOnce(replacementCore);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await supervisor.start();
    firstParser.emit("error");

    const restartPromise = supervisor.start();
    await Promise.resolve();
    const stopPromise = supervisor.stop();
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(firstWatcher.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(firstCore.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");

    firstWatcher.emit("exit");
    firstCore.emit("exit");

    await expect(restartPromise).resolves.toEqual({
      state: "stopped",
      children: []
    });
    await expect(stopPromise).resolves.toEqual({
      state: "stopped",
      children: []
    });
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(replacementWatcher.killRequested).toBe(false);
  });

  it("does not spawn duplicate chains for overlapping starts during degraded recovery", async () => {
    const firstWatcher = createMockChild(101);
    const firstParser = createMockChild(202);
    const firstCore = createMockChild(303);
    const secondWatcher = createMockChild(404);
    const secondParser = createMockChild(505);
    const secondCore = createMockChild(606);
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(firstParser)
      .mockReturnValueOnce(firstCore)
      .mockReturnValueOnce(secondWatcher)
      .mockReturnValueOnce(secondParser)
      .mockReturnValueOnce(secondCore);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await supervisor.start();
    firstParser.emit("error");

    const firstRestartPromise = supervisor.start();
    const secondRestartPromise = supervisor.start();
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(firstWatcher.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(firstCore.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");

    firstWatcher.emit("exit");
    firstCore.emit("exit");

    await expect(firstRestartPromise).resolves.toEqual({
      state: "running",
      children: [
        { name: "watcher", state: "running", pid: 404 },
        { name: "parser", state: "running", pid: 505 },
        { name: "core", state: "running", pid: 606 }
      ]
    });
    await expect(secondRestartPromise).resolves.toEqual({
      state: "running",
      children: [
        { name: "watcher", state: "running", pid: 404 },
        { name: "parser", state: "running", pid: 505 },
        { name: "core", state: "running", pid: 606 }
      ]
    });
    expect(spawn).toHaveBeenCalledTimes(6);
  });

  it("waits for owned children to exit before stop completes", async () => {
    const watcher = createMockChild(101);
    const parser = createMockChild(202);
    const core = createMockChild(303);
    const spawn = vi
      .fn()
      .mockReturnValueOnce(watcher)
      .mockReturnValueOnce(parser)
      .mockReturnValueOnce(core);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await supervisor.start();
    const stopPromise = supervisor.stop();
    await Promise.resolve();

    expect(watcher.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(parser.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(core.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(watcher.on).toHaveBeenCalledWith("exit", expect.any(Function));
    expect(parser.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(supervisor.getStatus()).toEqual({
      state: "stopped",
      children: [
        { name: "watcher", state: "running", pid: 101 },
        { name: "parser", state: "running", pid: 202 },
        { name: "core", state: "running", pid: 303 }
      ]
    });

    watcher.emit("exit");
    parser.emit("exit");
    await Promise.resolve();
    expect(core.killRequested).toBe(true);

    core.emit("exit");
    await stopPromise;

    expect(supervisor.getStatus()).toEqual({
      state: "stopped",
      children: [
        { name: "watcher", state: "stopped", pid: 101 },
        { name: "parser", state: "stopped", pid: 202 },
        { name: "core", state: "stopped", pid: 303 }
      ]
    });
  });

  it("bounds shutdown for a non-cooperative child by escalating after the timeout", async () => {
    vi.useFakeTimers();

    const watcher = createMockChild(101);
    const parser = createMockChild(202);
    const core = createMockChild(303);
    const spawn = vi
      .fn()
      .mockReturnValueOnce(watcher)
      .mockReturnValueOnce(parser)
      .mockReturnValueOnce(core);

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await supervisor.start();
    const stopPromise = supervisor.stop();
    let settled = false;
    void stopPromise.then(() => {
      settled = true;
    });

    parser.emit("exit");
    core.emit("exit");
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(watcher.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(CHILD_SHUTDOWN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(watcher.kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await stopPromise;

    expect(watcher.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(supervisor.getStatus()).toEqual({
      state: "stopped",
      children: [
        { name: "watcher", state: "stopped", pid: 101 },
        { name: "parser", state: "stopped", pid: 202 },
        { name: "core", state: "stopped", pid: 303 }
      ]
    });
  });

  it("does not touch unrelated processes when stop is called before start", async () => {
    const spawn = vi.fn();

    const supervisor = createProcessSupervisor({
      runtimePaths: {
        dataRoot: "/runtime-data",
        cliEntrypoint: "/bundle/cli/dist/index.js",
        cliWorkingDirectory: "/bundle/cli",
        coreEntrypoint: "/bundle/core/dist/server.js",
        coreWorkingDirectory: "/bundle/core"
      },
      spawn,
      process: { execPath: "/Applications/Agent Metrics.app/Contents/MacOS/Agent Metrics" }
    });

    await supervisor.stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toEqual({
      state: "stopped",
      children: []
    });
  });
});
