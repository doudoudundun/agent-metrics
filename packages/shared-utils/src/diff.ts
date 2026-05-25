export function diffTextStats(before: string, after: string): { insertions: number; deletions: number } {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const lcsLength = longestCommonSubsequenceLength(beforeLines, afterLines);
  const insertions = afterLines.length - lcsLength;
  const deletions = beforeLines.length - lcsLength;

  return { insertions, deletions };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function longestCommonSubsequenceLength(beforeLines: string[], afterLines: string[]): number {
  const previousRow = new Array(afterLines.length + 1).fill(0);
  const currentRow = new Array(afterLines.length + 1).fill(0);

  for (let beforeIndex = 1; beforeIndex <= beforeLines.length; beforeIndex += 1) {
    for (let afterIndex = 1; afterIndex <= afterLines.length; afterIndex += 1) {
      if (beforeLines[beforeIndex - 1] === afterLines[afterIndex - 1]) {
        currentRow[afterIndex] = previousRow[afterIndex - 1] + 1;
      } else {
        currentRow[afterIndex] = Math.max(previousRow[afterIndex], currentRow[afterIndex - 1]);
      }
    }

    for (let afterIndex = 0; afterIndex <= afterLines.length; afterIndex += 1) {
      previousRow[afterIndex] = currentRow[afterIndex];
      currentRow[afterIndex] = 0;
    }
  }

  return previousRow[afterLines.length];
}
