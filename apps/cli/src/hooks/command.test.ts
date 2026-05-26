import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../index.js";
import { getHookPaths } from "./paths.js";
import { buildClaudeHooksSettingsPatch } from "./sample-config.js";

const ORIGINAL_STDIN = process.stdin;

afterEach(() => {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: ORIGINAL_STDIN
  });
  vi.restoreAllMocks();
});

describe("hooks CLI commands", () => {
  it("runs hooks print-config and prints the generated JSON patch", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-cli-"));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await buildProgram().parseAsync([
      "node",
      "agent-metrics",
      "hooks",
      "print-config",
      "--repo-root",
      repoRoot
    ]);

    const printed = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");

    expect(JSON.parse(printed)).toEqual(buildClaudeHooksSettingsPatch({ repoRoot }));
  });

  it("runs hooks install through Commander and writes the settings file", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-cli-"));
    const settingsRoot = await mkdtemp(join(tmpdir(), "agent-metrics-settings-"));
    const settingsPath = join(settingsRoot, "settings.json");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await buildProgram().parseAsync([
      "node",
      "agent-metrics",
      "hooks",
      "install",
      "--scope",
      "global",
      "--repo-root",
      repoRoot,
      "--settings-path",
      settingsPath
    ]);

    const printed = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    const installed = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };

    expect(printed).toContain(settingsPath);
    expect(installed.hooks?.PreToolUse).toBeDefined();
    expect(installed.hooks?.PostToolUseFailure).toBeDefined();
  });

  it("runs hooks collect through Commander and appends raw and normalized events", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-metrics-cli-"));
    const stdin = Readable.from([
      JSON.stringify({
        session_id: "ses_cli_1",
        cwd: repoRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_use_id: "tool_cli_1",
        tool_input: {
          file_path: "README.md"
        }
      })
    ]);

    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      value: false
    });
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: stdin
    });

    await buildProgram().parseAsync([
      "node",
      "agent-metrics",
      "hooks",
      "collect",
      "--repo-root",
      repoRoot,
      "--hook-event-name",
      "PreToolUse"
    ]);

    const paths = getHookPaths(repoRoot);
    const rawLog = await readFile(paths.rawHookLogPath, "utf8");
    const eventLog = await readFile(paths.eventLogPath, "utf8");

    expect(rawLog).toContain("\"hook_event_name\":\"PreToolUse\"");
    expect(eventLog).toContain("\"type\":\"tool.called\"");
    expect(eventLog).toContain("\"tool_name\":\"Read\"");
  });
});
