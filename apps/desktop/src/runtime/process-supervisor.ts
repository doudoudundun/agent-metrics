import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import type { DesktopRuntimePaths } from "../runtime-paths.js";

type SupervisorState = "idle" | "running" | "degraded" | "stopped";
type ChildState = "running" | "stopped";
type ChildName = "watcher" | "parser" | "core";

type SpawnedChild = {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit" | "error", listener: () => void): SpawnedChild;
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

type ManagedChild = {
  readonly child: SpawnedChild;
  readonly name: ChildName;
  readonly whenStopped: Promise<void>;
  shutdownRequested: boolean;
  forceKillRequested: boolean;
  resolveStopped(): void;
  state: ChildState;
};

export const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

export type ProcessSupervisorStatus = {
  state: SupervisorState;
  children: Array<{
    name: ChildName;
    state: ChildState;
    pid: number | undefined;
  }>;
};

export function createProcessSupervisor({
  runtimePaths,
  spawn = nodeSpawn as SpawnFn,
  process = globalThis.process
}: {
  runtimePaths: Pick<
    DesktopRuntimePaths,
    "dataRoot" | "cliEntrypoint" | "cliWorkingDirectory" | "coreEntrypoint" | "coreWorkingDirectory"
  >;
  spawn?: SpawnFn;
  process?: ProcessLike;
}) {
  const managedChildren: ManagedChild[] = [];
  let state: SupervisorState = "idle";
  let lifecycleOperation = Promise.resolve();
  let stopIntentVersion = 0;

  function runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycleOperation.then(operation, operation);
    lifecycleOperation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function markStopped(managedChild: ManagedChild): void {
    if (managedChild.state === "stopped") {
      return;
    }

    managedChild.state = "stopped";
    managedChild.resolveStopped();

    if (state === "running") {
      state = "degraded";
    }
  }

  async function stopManagedChildren(children: readonly ManagedChild[]): Promise<void> {
    const pendingStops: Promise<void>[] = [];

    for (const managedChild of children) {
      if (managedChild.state === "running") {
        if (!managedChild.shutdownRequested) {
          managedChild.shutdownRequested = true;
          managedChild.child.kill("SIGTERM");
        }
        pendingStops.push(
          Promise.race([
            managedChild.whenStopped,
            new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                if (managedChild.state === "running" && !managedChild.forceKillRequested) {
                  managedChild.forceKillRequested = true;
                  managedChild.child.kill("SIGKILL");
                  markStopped(managedChild);
                }

                resolve();
              }, CHILD_SHUTDOWN_TIMEOUT_MS);

              void managedChild.whenStopped.finally(() => {
                clearTimeout(timeout);
              });
            })
          ])
        );
      }
    }

    await Promise.all(pendingStops);
  }

  function startChild(
    name: ChildName,
    cwd: string,
    args: readonly string[],
    extraEnv: NodeJS.ProcessEnv = {}
  ): ManagedChild {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ...extraEnv
      },
      stdio: "ignore"
    });

    let resolveStopped = () => {};
    const whenStopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });

    const managedChild: ManagedChild = {
      child,
      name,
      whenStopped,
      shutdownRequested: false,
      forceKillRequested: false,
      resolveStopped,
      state: "running"
    };

    child.on("exit", () => {
      markStopped(managedChild);
    });
    child.on("error", () => {
      markStopped(managedChild);
    });

    return managedChild;
  }

  return {
    async start(): Promise<ProcessSupervisorStatus> {
      return runLifecycleOperation(async () => {
        if (state === "running") {
          return this.getStatus();
        }

        const stopIntentAtStart = stopIntentVersion;

        if (state === "degraded") {
          await stopManagedChildren(managedChildren);

          if (stopIntentVersion !== stopIntentAtStart) {
            managedChildren.length = 0;
            state = "stopped";
            return this.getStatus();
          }
        }

        managedChildren.length = 0;
        state = "running";
        const startedChildren: ManagedChild[] = [];

        try {
          startedChildren.push(
            startChild("watcher", runtimePaths.cliWorkingDirectory, [
              runtimePaths.cliEntrypoint,
              "hooks",
              "watch",
              "--scope",
              "global",
              "--repo-root",
              runtimePaths.dataRoot,
              "--cli-path",
              runtimePaths.cliEntrypoint
            ])
          );
          startedChildren.push(
            startChild("parser", runtimePaths.cliWorkingDirectory, [
              runtimePaths.cliEntrypoint,
              "hooks",
              "parse",
              "--follow",
              "--repo-root",
              runtimePaths.dataRoot
            ])
          );
          startedChildren.push(
            startChild(
              "core",
              runtimePaths.coreWorkingDirectory,
              [runtimePaths.coreEntrypoint],
              {
                AGENT_METRICS_DB_PATH: join(
                  runtimePaths.dataRoot,
                  "data",
                  "sqlite",
                  "metrics.sqlite"
                ),
                AGENT_METRICS_EVENT_LOG_PATH: join(
                  runtimePaths.dataRoot,
                  "data",
                  "events",
                  "events.jsonl"
                ),
                AGENT_METRICS_REPO_ROOT: runtimePaths.dataRoot
              }
            )
          );

          managedChildren.push(...startedChildren);
        } catch (error) {
          await stopManagedChildren(startedChildren);
          managedChildren.length = 0;
          state = "stopped";
          throw error;
        }

        return this.getStatus();
      });
    },

    getStatus(): ProcessSupervisorStatus {
      return {
        state,
        children: managedChildren.map(({ child, name, state: childState }) => ({
          name,
          state: childState,
          pid: child.pid
        }))
      };
    },

    async stop(): Promise<ProcessSupervisorStatus> {
      stopIntentVersion += 1;

      return runLifecycleOperation(async () => {
        state = "stopped";
        await stopManagedChildren(managedChildren);
        return this.getStatus();
      });
    }
  };
}
