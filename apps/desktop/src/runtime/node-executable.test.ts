import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { resolveDesktopNodeExecutable } from "./node-executable.js";

function createSpawnResult(status: number): SpawnSyncReturns<Buffer> {
  return {
    status,
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    signal: null
  };
}

describe("resolve desktop node executable", () => {
  it("prefers an explicit env node path when it passes the runtime check", () => {
    const spawnNode = vi.fn(() => createSpawnResult(0));

    const nodePath = resolveDesktopNodeExecutable({
      cliWorkingDirectory: "D:/repo/apps/cli",
      coreWorkingDirectory: "D:/repo/apps/core",
      currentExecutablePath: "D:/repo/node_modules/electron/dist/electron.exe",
      env: {
        AGENT_METRICS_NODE_PATH: "D:/custom/node.exe"
      },
      platform: "win32",
      arch: "x64",
      fileExists: () => true,
      spawnNode
    });

    expect(nodePath).toBe("D:/custom/node.exe");
    expect(spawnNode).toHaveBeenCalledWith(
      "D:/custom/node.exe",
      ["-e", expect.stringContaining("better-sqlite3")],
      expect.objectContaining({
        cwd: "D:/repo/apps/core",
        stdio: "ignore"
      })
    );
  });

  it("falls back to the managed repo node when Electron cannot host native core modules", () => {
    const spawnNode = vi
      .fn()
      .mockReturnValueOnce(createSpawnResult(0));

    const nodePath = resolveDesktopNodeExecutable({
      cliWorkingDirectory: "D:/repo/apps/cli",
      coreWorkingDirectory: "D:/repo/apps/core",
      currentExecutablePath: "D:/repo/node_modules/electron/dist/electron.exe",
      env: {},
      platform: "win32",
      arch: "x64",
      fileExists: (candidate) =>
        candidate.toLowerCase() === "d:\\repo\\.runtime\\node-v22.22.3-win-x64\\node.exe",
      spawnNode
    });

    expect(nodePath).toBe("D:\\repo\\.runtime\\node-v22.22.3-win-x64\\node.exe");
    expect(spawnNode).toHaveBeenNthCalledWith(
      1,
      "D:\\repo\\.runtime\\node-v22.22.3-win-x64\\node.exe",
      ["-e", expect.stringContaining("better-sqlite3")],
      expect.objectContaining({
        cwd: "D:/repo/apps/core",
        stdio: "ignore"
      })
    );
  });

  it("tries the PATH node only after explicit and managed candidates fail", () => {
    const spawnNode = vi
      .fn()
      .mockReturnValueOnce(createSpawnResult(1))
      .mockReturnValueOnce(createSpawnResult(0));

    const nodePath = resolveDesktopNodeExecutable({
      cliWorkingDirectory: "D:/repo/apps/cli",
      coreWorkingDirectory: "D:/repo/apps/core",
      currentExecutablePath: "D:/repo/node_modules/electron/dist/electron.exe",
      env: {
        AGENT_METRICS_NODE_PATH: "D:/custom/node.exe"
      },
      platform: "win32",
      arch: "x64",
      fileExists: () => false,
      spawnNode
    });

    expect(nodePath).toBe("node");
    expect(spawnNode).toHaveBeenNthCalledWith(
      2,
      "node",
      ["-e", expect.stringContaining("better-sqlite3")],
      expect.objectContaining({
        cwd: "D:/repo/apps/core",
        stdio: "ignore"
      })
    );
  });
});
