#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import type { SessionEndedEvent, SessionStartedEvent } from "@agent-metrics/event-schema";

export type WrappedSessionOptions = {
  args: string[];
  eventLogPath: string;
  workspacePath: string;
  runCommand?: (args: string[]) => Promise<number>;
};

async function defaultRunCommand(args: string[], workspacePath: string): Promise<number> {
  if (args.length === 0) {
    return 0;
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: workspacePath,
      shell: false,
      stdio: "inherit",
      windowsHide: true
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }

      resolve(signal ? 1 : 0);
    });
  });
}

export async function runWrappedSession(options: WrappedSessionOptions): Promise<number> {
  const sessionId = randomUUID();
  const startedAt = new Date();
  const runCommand = options.runCommand ?? ((args: string[]) => defaultRunCommand(args, options.workspacePath));
  let exitCode: number | null = null;
  let failure: unknown = null;

  const startedEvent: SessionStartedEvent = {
    event_id: randomUUID(),
    session_id: sessionId,
    timestamp: startedAt.toISOString(),
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: options.workspacePath,
    type: "session.started"
  };

  await appendJsonLine(options.eventLogPath, startedEvent);
  try {
    exitCode = await runCommand(options.args);
  } catch (error) {
    failure = error;
  }

  const endedAt = new Date();

  const endedEvent: SessionEndedEvent = {
    event_id: randomUUID(),
    session_id: sessionId,
    timestamp: endedAt.toISOString(),
    source_vendor: "claude-code",
    source_adapter: "claude",
    workspace_path: options.workspacePath,
    type: "session.ended",
    exit_code: exitCode,
    duration_ms: endedAt.getTime() - startedAt.getTime()
  };

  await appendJsonLine(options.eventLogPath, endedEvent);
  if (failure) {
    throw failure;
  }
  return exitCode ?? 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void (async () => {
    const { Command } = await import("commander");
    const program = new Command();

    program
      .name("agent-metrics")
      .command("wrap")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument("<command>")
      .argument("[args...]")
      .option("--event-log-path <path>", "Path to event log", "data/events/events.jsonl")
      .action(async (command: string, args: string[], options: { eventLogPath: string }) => {
        const exitCode = await runWrappedSession({
          args: [command, ...args],
          eventLogPath: options.eventLogPath,
          workspacePath: process.cwd()
        });
        process.exitCode = exitCode;
      });

    await program.parseAsync(process.argv);
  })();
}
