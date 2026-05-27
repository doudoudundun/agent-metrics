import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ensureParentDir } from "@agent-metrics/shared-utils";
import {
  buildClaudeHooksConfig,
  type ClaudeCommandHook,
  type ClaudeHookMatcher,
  type ClaudeHooksConfig
} from "./sample-config.js";

type JsonObject = Record<string, unknown>;

export type EnsureClaudeHooksStatus = "created" | "updated" | "unchanged" | "invalid-json";

export type EnsureClaudeHooksResult = {
  status: EnsureClaudeHooksStatus;
  settingsPath: string;
};

type ReadSettingsResult =
  | {
      status: "ok";
      contents: string | null;
      value: JsonObject;
    }
  | {
      status: "invalid-json";
    };

export function getDefaultClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export async function ensureClaudeHooks(input: {
  repoRoot: string;
  settingsPath?: string;
}): Promise<EnsureClaudeHooksResult> {
  const settingsPath = resolve(input.settingsPath ?? getDefaultClaudeSettingsPath());
  const existing = await readSettingsJson(settingsPath);

  if (existing.status === "invalid-json") {
    return {
      status: "invalid-json",
      settingsPath
    };
  }

  const nextSettings = {
    ...existing.value,
    hooks: mergeHookTrees(
      existing.value.hooks,
      buildClaudeHooksConfig({
        repoRoot: resolve(input.repoRoot)
      })
    )
  };

  if (JSON.stringify(existing.value) === JSON.stringify(nextSettings)) {
    return {
      status: "unchanged",
      settingsPath
    };
  }

  await ensureParentDir(settingsPath);
  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  return {
    status: existing.contents === null ? "created" : "updated",
    settingsPath
  };
}

export async function installClaudeHooks(input: {
  repoRoot: string;
  settingsPath?: string;
}): Promise<void> {
  await ensureClaudeHooks(input);
}

async function readSettingsJson(settingsPath: string): Promise<ReadSettingsResult> {
  try {
    const contents = await readFile(settingsPath, "utf8");
    const trimmed = contents.trim();

    if (trimmed.length === 0) {
      return {
        status: "ok",
        contents,
        value: {}
      };
    }

    const parsed = JSON.parse(trimmed) as unknown;

    if (!isRecord(parsed)) {
      return {
        status: "invalid-json"
      };
    }

    return {
      status: "ok",
      contents,
      value: parsed
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        status: "ok",
        contents: null,
        value: {}
      };
    }

    if (error instanceof SyntaxError) {
      return {
        status: "invalid-json"
      };
    }

    throw error;
  }
}

function mergeHookTrees(existingHooksRaw: unknown, generatedHooks: ClaudeHooksConfig): JsonObject {
  const existingHooks = isRecord(existingHooksRaw) ? existingHooksRaw : {};
  const mergedHooks: JsonObject = { ...existingHooks };

  for (const [eventName, generatedEntries] of Object.entries(generatedHooks) as Array<
    [keyof ClaudeHooksConfig, ClaudeHookMatcher[]]
  >) {
    mergedHooks[eventName] = mergeHookEntries(existingHooks[eventName], generatedEntries, eventName);
  }

  return mergedHooks;
}

function mergeHookEntries(
  existingEntriesRaw: unknown,
  generatedEntries: ClaudeHookMatcher[],
  eventName: keyof ClaudeHooksConfig
): unknown[] {
  const mergedEntries = Array.isArray(existingEntriesRaw)
    ? existingEntriesRaw
        .map((entry) => stripManagedHooks(entry, eventName))
        .filter((entry): entry is unknown => entry !== null)
    : [];

  for (const generatedEntry of generatedEntries) {
    const matcherIndex = mergedEntries.findIndex((entry) =>
      isMatcherEntry(entry, generatedEntry.matcher)
    );

    if (matcherIndex === -1) {
      mergedEntries.push(cloneHookEntry(generatedEntry));
      continue;
    }

    const existingEntry = mergedEntries[matcherIndex];

    if (!isRecord(existingEntry)) {
      mergedEntries[matcherIndex] = cloneHookEntry(generatedEntry);
      continue;
    }

    mergedEntries[matcherIndex] = {
      ...existingEntry,
      matcher: generatedEntry.matcher,
      hooks: mergeCommandHooks(existingEntry.hooks, generatedEntry.hooks)
    };
  }

  return mergedEntries;
}

function mergeCommandHooks(existingHooksRaw: unknown, generatedHooks: ClaudeCommandHook[]): unknown[] {
  const mergedHooks = Array.isArray(existingHooksRaw) ? [...existingHooksRaw] : [];

  for (const generatedHook of generatedHooks) {
    if (!mergedHooks.some((existingHook) => isSameCommandHook(existingHook, generatedHook))) {
      mergedHooks.push(cloneCommandHook(generatedHook));
    }
  }

  return mergedHooks;
}

function isMatcherEntry(value: unknown, matcher: string): boolean {
  return isRecord(value) && value.matcher === matcher;
}

function isSameCommandHook(value: unknown, expected: ClaudeCommandHook): boolean {
  if (!isRecord(value) || value.type !== expected.type || value.command !== expected.command) {
    return false;
  }

  if (!Array.isArray(value.args) || value.args.length !== expected.args.length) {
    return false;
  }

  return value.args.every((arg, index) => typeof arg === "string" && arg === expected.args[index]);
}

function cloneHookEntry(entry: ClaudeHookMatcher): ClaudeHookMatcher {
  return {
    matcher: entry.matcher,
    hooks: entry.hooks.map(cloneCommandHook)
  };
}

function cloneCommandHook(hook: ClaudeCommandHook): ClaudeCommandHook {
  return {
    type: hook.type,
    command: hook.command,
    args: [...hook.args]
  };
}

function stripManagedHooks(
  entry: unknown,
  eventName: keyof ClaudeHooksConfig
): Record<string, unknown> | unknown | null {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return entry;
  }

  const hooks = entry.hooks.filter((hook) => !isManagedAgentMetricsHook(hook, eventName));

  if (hooks.length === 0) {
    return null;
  }

  return {
    ...entry,
    hooks
  };
}

function isManagedAgentMetricsHook(
  value: unknown,
  eventName: keyof ClaudeHooksConfig
): boolean {
  if (!isRecord(value) || value.type !== "command" || value.command !== "node" || !Array.isArray(value.args)) {
    return false;
  }

  const args = value.args.filter((arg): arg is string => typeof arg === "string");

  return (
    args.length >= 7 &&
    isAgentMetricsCliPath(args[0]) &&
    args[1] === "hooks" &&
    args[2] === "collect" &&
    args[3] === "--hook-event-name" &&
    args[4] === eventName &&
    args[5] === "--repo-root"
  );
}

function isAgentMetricsCliPath(filePath: string): boolean {
  return filePath.replace(/\\/g, "/").endsWith("/apps/cli/dist/index.js");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
