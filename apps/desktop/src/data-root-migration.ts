import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const JSONL_FILES = [
  join("data", "events", "events.jsonl"),
  join("data", "hooks", "raw", "claude-code.jsonl")
] as const;
const MARKER_PATH = join("data", "migration", "legacy-data-root.json");

export type DataRootMigrationResult = {
  migrated: boolean;
  copiedRoot: boolean;
  backupPath: string | null;
  appendedLines: Record<string, number>;
  migratedSources: string[];
};

export async function migrateLegacyDataRoots(input: {
  dataRoot: string;
  legacyDataRoots: string[];
  now?: () => Date;
}): Promise<DataRootMigrationResult> {
  const now = input.now ?? (() => new Date());
  const sources = await resolveExistingSources(input.dataRoot, input.legacyDataRoots);
  const appendedLines = Object.fromEntries(JSONL_FILES.map((file) => [toPortablePath(file), 0]));

  if (sources.length === 0 || await pathExists(join(input.dataRoot, MARKER_PATH))) {
    return {
      migrated: false,
      copiedRoot: false,
      backupPath: null,
      appendedLines,
      migratedSources: []
    };
  }

  if (!(await pathExists(input.dataRoot))) {
    await mkdir(dirname(input.dataRoot), { recursive: true });
    await cp(sources[0], input.dataRoot, { recursive: true });
    await writeMarker(input.dataRoot, sources, now());

    return {
      migrated: true,
      copiedRoot: true,
      backupPath: null,
      appendedLines,
      migratedSources: sources
    };
  }

  const backupPath = `${input.dataRoot}.backup-${formatTimestamp(now())}`;
  await cp(input.dataRoot, backupPath, { recursive: true });

  for (const sourceRoot of sources) {
    for (const relativePath of JSONL_FILES) {
      appendedLines[toPortablePath(relativePath)] += await mergeJsonlFile(
        join(input.dataRoot, relativePath),
        join(sourceRoot, relativePath)
      );
    }

    await copyMissingTree(join(sourceRoot, "data", "hooks", "snapshots"), join(input.dataRoot, "data", "hooks", "snapshots"));
  }

  await writeMarker(input.dataRoot, sources, now());

  return {
    migrated: true,
    copiedRoot: false,
    backupPath,
    appendedLines,
    migratedSources: sources
  };
}

async function resolveExistingSources(dataRoot: string, legacyDataRoots: string[]): Promise<string[]> {
  const normalizedTarget = normalizePath(dataRoot);
  const sources: string[] = [];

  for (const source of legacyDataRoots) {
    if (normalizePath(source) === normalizedTarget || !(await pathExists(source))) {
      continue;
    }

    sources.push(source);
  }

  return sources;
}

async function mergeJsonlFile(targetPath: string, sourcePath: string): Promise<number> {
  const targetLines = await readJsonLines(targetPath);
  const sourceLines = await readJsonLines(sourcePath);

  if (sourceLines.length === 0) {
    return 0;
  }

  const seen = new Set(targetLines.map(resolveJsonlKey));
  const missing = sourceLines.filter((line) => {
    const key = resolveJsonlKey(line);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  if (missing.length === 0) {
    return 0;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, [...targetLines, ...missing].join("\n") + "\n", "utf8");
  return missing.length;
}

async function readJsonLines(filePath: string): Promise<string[]> {
  try {
    const contents = await readFile(filePath, "utf8");

    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function resolveJsonlKey(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const id = parsed.event_id ?? parsed.raw_event_id;

    return typeof id === "string" && id.length > 0 ? id : line;
  } catch {
    return line;
  }
}

async function copyMissingTree(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    return;
  }

  await cp(sourcePath, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
}

async function writeMarker(dataRoot: string, sources: string[], migratedAt: Date): Promise<void> {
  const markerPath = join(dataRoot, MARKER_PATH);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(
    markerPath,
    JSON.stringify(
      {
        migratedAt: migratedAt.toISOString(),
        sources
      },
      null,
      2
    ),
    "utf8"
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replaceAll(/\D/g, "").slice(0, 14);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").toLowerCase();
}

function toPortablePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const dataRoot = readFlag(args, "--data-root");
  const legacyDataRoots = readFlags(args, "--legacy-root");

  if (!dataRoot) {
    throw new Error("Missing required --data-root argument.");
  }

  const result = await migrateLegacyDataRoots({ dataRoot, legacyDataRoots });
  console.log(JSON.stringify(result));
}

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);

  if (index === -1 || index + 1 >= args.length) {
    return null;
  }

  return args[index + 1] ?? null;
}

function readFlags(args: string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) {
      values.push(args[index + 1]);
      index += 1;
    }
  }

  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).toString()) {
  runCli().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
