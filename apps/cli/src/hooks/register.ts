import type { Command } from "commander";
import { registerCollectCommand } from "./collect.js";
import { registerEnsureCommand } from "./ensure.js";
import { registerInstallCommand } from "./install.js";
import { registerParseCommand } from "./parse.js";
import { registerPrintConfigCommand } from "./sample-config.js";
import { registerWatchCommand } from "./watch.js";

export function registerHooksCommands(program: Command): void {
  const hooks = program.command("hooks");

  registerCollectCommand(hooks);
  registerEnsureCommand(hooks);
  registerInstallCommand(hooks);
  registerParseCommand(hooks);
  registerPrintConfigCommand(hooks);
  registerWatchCommand(hooks);
}
