import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appendJsonLine } from "@agent-metrics/shared-utils";
import type { SessionEndedEvent, SessionStartedEvent } from "@agent-metrics/event-schema";

export type WrappedSessionOptions = {
  args: string[];
  eventLogPath: string;
  workspacePath: string;
  runCommand?: (args: string[]) => Promise<number>;
};

async function defaultRunCommand(): Promise<number> {
  return 0;
}

export async function runWrappedSession(options: WrappedSessionOptions): Promise<number> {
  const sessionId = randomUUID();
  const startedAt = new Date();
  const runCommand = options.runCommand ?? defaultRunCommand;

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
  const exitCode = await runCommand(options.args);
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
  return exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void (async () => {
    const { Command } = await import("commander");
    const program = new Command();

    program
      .name("agent-metrics")
      .command("wrap")
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
