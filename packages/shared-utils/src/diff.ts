export function diffTextStats(before: string, after: string): { insertions: number; deletions: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let insertions = 0;
  let deletions = 0;
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    if (afterLines[afterIndex + 1] === beforeLines[beforeIndex]) {
      insertions += 1;
      afterIndex += 1;
      continue;
    }

    if (beforeLines[beforeIndex + 1] === afterLines[afterIndex]) {
      deletions += 1;
      beforeIndex += 1;
      continue;
    }

    insertions += 1;
    deletions += 1;
    beforeIndex += 1;
    afterIndex += 1;
  }

  insertions += Math.max(0, afterLines.length - afterIndex);
  deletions += Math.max(0, beforeLines.length - beforeIndex);

  return { insertions, deletions };
}
