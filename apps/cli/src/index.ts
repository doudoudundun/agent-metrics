#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerHooksCommands } from "./hooks/register.js";

export function buildProgram(): Command {
  const program = new Command();

  program.name("agent-metrics");
  registerHooksCommands(program);

  return program;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void buildProgram().parseAsync(process.argv);
}
