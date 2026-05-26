import type { Command } from "commander";
import { registerCollectCommand } from "./collect.js";
import { registerInstallCommand } from "./install.js";
import { registerPrintConfigCommand } from "./sample-config.js";

export function registerHooksCommands(program: Command): void {
  const hooks = program.command("hooks");

  registerCollectCommand(hooks);
  registerInstallCommand(hooks);
  registerPrintConfigCommand(hooks);
}
