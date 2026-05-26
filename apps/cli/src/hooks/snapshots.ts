import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

type SnapshotEntry = {
  path: string;
  before: string;
};

type SnapshotFile = {
  toolUseId: string;
  workspacePath: string;
  files: SnapshotEntry[];
};

export async function captureBeforeSnapshots(input: {
  snapshotRoot: string;
  toolUseId: string;
  workspacePath: string;
  targets: string[];
}): Promise<void> {
  const snapshotPath = getSnapshotFilePath(input.snapshotRoot, input.toolUseId);

  if (snapshotPath === null) {
    return;
  }

  const workspacePath = resolve(input.workspacePath);
  const files: SnapshotEntry[] = [];

  for (const target of input.targets) {
    if (target.length === 0) {
      continue;
    }

    const absolutePath = resolveTargetPath(workspacePath, target);

    if (absolutePath === null) {
      continue;
    }

    files.push({
      path: target,
      before: await readTextOrEmpty(absolutePath)
    });
  }

  if (files.length === 0) {
    return;
  }

  await mkdir(input.snapshotRoot, { recursive: true });
  await writeFile(
    snapshotPath,
    JSON.stringify({
      toolUseId: input.toolUseId,
      workspacePath,
      files
    } satisfies SnapshotFile),
    "utf8"
  );
}

export async function collectChangedSnapshots(input: {
  snapshotRoot: string;
  toolUseId: string;
}): Promise<
  Array<{
    path: string;
    before: string;
    after: string;
  }>
> {
  const snapshotPath = getSnapshotFilePath(input.snapshotRoot, input.toolUseId);

  if (snapshotPath === null) {
    return [];
  }

  const snapshot = await readSnapshotFile(snapshotPath);

  if (snapshot === null) {
    return [];
  }

  const changedFiles: Array<{
    path: string;
    before: string;
    after: string;
  }> = [];

  for (const file of snapshot.files) {
    const absolutePath = resolveTargetPath(snapshot.workspacePath, file.path);

    if (absolutePath === null) {
      continue;
    }

    const after = await readTextOrEmpty(absolutePath);

    if (file.before !== after) {
      changedFiles.push({
        path: file.path,
        before: file.before,
        after
      });
    }
  }

  await unlink(snapshotPath).catch(() => undefined);

  return changedFiles;
}

export async function discardSnapshots(input: {
  snapshotRoot: string;
  toolUseId?: string;
}): Promise<void> {
  const snapshotPath =
    typeof input.toolUseId === "string"
      ? getSnapshotFilePath(input.snapshotRoot, input.toolUseId)
      : null;

  if (snapshotPath === null) {
    return;
  }

  await unlink(snapshotPath).catch(() => undefined);
}

function getSnapshotFilePath(snapshotRoot: string, toolUseId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(toolUseId)) {
    return null;
  }

  return join(snapshotRoot, `${toolUseId}.json`);
}

function resolveTargetPath(workspacePath: string, target: string): string | null {
  const absoluteWorkspacePath = resolve(workspacePath);
  const absoluteTargetPath = isAbsolute(target)
    ? resolve(target)
    : resolve(absoluteWorkspacePath, target);

  if (!isWithinBoundary(absoluteWorkspacePath, absoluteTargetPath)) {
    return null;
  }

  return absoluteTargetPath;
}

async function readSnapshotFile(snapshotPath: string): Promise<SnapshotFile | null> {
  try {
    const contents = await readFile(snapshotPath, "utf8");
    return JSON.parse(contents) as SnapshotFile;
  } catch {
    return null;
  }
}

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function isWithinBoundary(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}
