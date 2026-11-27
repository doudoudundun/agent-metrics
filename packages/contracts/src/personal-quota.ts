import { z } from "zod";
import { Rfc3339 } from "./common.js";

export const PersonalQuotaTokensSchema = z.object({
  uncached: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative()
});

export const PersonalQuotaFamilySchema = z.object({
  limitId: z.string().min(1),
  limitName: z.string().min(1),
  accountUsedPercent: z.number().finite().nonnegative(),
  resetsAt: Rfc3339.nullable(),
  windowStart: Rfc3339,
  tokens: PersonalQuotaTokensSchema
});

export const PersonalQuotaResponseSchema = z.object({
  families: z.array(PersonalQuotaFamilySchema)
});

export type PersonalQuotaTokens = z.infer<typeof PersonalQuotaTokensSchema>;
export type PersonalQuotaFamily = z.infer<typeof PersonalQuotaFamilySchema>;
export type PersonalQuotaResponse = z.infer<typeof PersonalQuotaResponseSchema>;

export type PersonalQuotaCoefficients = {
  readonly uncached: number;
  readonly cacheRead: number;
  readonly output: number;
};

export type PersonalQuotaFit = {
  readonly xtx: readonly [number, number, number, number, number, number];
  readonly xty: readonly [number, number, number];
  readonly samples: number;
  readonly residual: number | null;
  readonly lastTokens: PersonalQuotaTokens | null;
  readonly lastMeterDelta: number | null;
};

export function emptyPersonalQuotaFit(): PersonalQuotaFit {
  return {
    xtx: [0, 0, 0, 0, 0, 0],
    xty: [0, 0, 0],
    samples: 0,
    residual: null,
    lastTokens: null,
    lastMeterDelta: null
  };
}

/** Antigravity meters Argon, Carbon, other Gemini, and Claude/GPT apart. */
export function antigravityLimitIdForModel(modelId: string | null): string | null {
  const base = (modelId ?? "").slice((modelId ?? "").lastIndexOf("/") + 1).toLowerCase();
  if (base.includes("argon")) {
    return "gemini-argon";
  }
  if (base.includes("carbon")) {
    return "gemini-carbon";
  }
  if (base.startsWith("gemini") || base.includes("gemini")) {
    return "gemini";
  }
  if (base.startsWith("claude") || base.startsWith("gpt")) {
    return "3p";
  }
  return null;
}

export function subtractPersonalQuotaTokens(
  later: PersonalQuotaTokens,
  earlier: PersonalQuotaTokens
): PersonalQuotaTokens | null {
  const tokens = {
    uncached: later.uncached - earlier.uncached,
    cacheRead: later.cacheRead - earlier.cacheRead,
    output: later.output - earlier.output
  };
  if (tokens.uncached < 0 || tokens.cacheRead < 0 || tokens.output < 0) {
    return null;
  }
  if (tokens.uncached + tokens.cacheRead + tokens.output <= 0) {
    return null;
  }
  return tokens;
}

function matrixScale(rows: readonly (readonly number[])[]): number {
  let scale = 1;
  for (const row of rows) {
    for (const value of row) {
      scale = Math.max(scale, Math.abs(value));
    }
  }
  return scale;
}

function solveCoefficients(fit: PersonalQuotaFit): PersonalQuotaCoefficients | null {
  const [a00, a01, a02, a11, a12, a22] = fit.xtx;
  const matrix = [
    [a00, a01, a02],
    [a01, a11, a12],
    [a02, a12, a22]
  ];
  const vector = [...fit.xty];
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      const candidate = matrix[row]?.[column] ?? 0;
      const current = matrix[pivot]?.[column] ?? 0;
      if (Math.abs(candidate) > Math.abs(current)) {
        pivot = row;
      }
    }
    const pivotRow = matrix[pivot];
    if (pivotRow === undefined || Math.abs(pivotRow[column] ?? 0) <= 1e-9 * matrixScale(matrix)) {
      return null;
    }
    if (pivot !== column) {
      matrix[pivot] = matrix[column] ?? pivotRow;
      matrix[column] = pivotRow;
      const saved = vector[pivot] ?? 0;
      vector[pivot] = vector[column] ?? 0;
      vector[column] = saved;
    }
    const scale = pivotRow[column] ?? 0;
    for (let row = column + 1; row < 3; row += 1) {
      const target = matrix[row];
      if (target === undefined) {
        continue;
      }
      const factor = (target[column] ?? 0) / scale;
      for (let index = column; index < 3; index += 1) {
        target[index] = (target[index] ?? 0) - factor * (pivotRow[index] ?? 0);
      }
      vector[row] = (vector[row] ?? 0) - factor * (vector[column] ?? 0);
    }
  }
  const solved = [0, 0, 0];
  for (let row = 2; row >= 0; row -= 1) {
    let value = vector[row] ?? 0;
    const equation = matrix[row];
    for (let column = row + 1; column < 3; column += 1) {
      value -= (equation?.[column] ?? 0) * (solved[column] ?? 0);
    }
    const diagonal = equation?.[row] ?? 0;
    if (Math.abs(diagonal) <= 1e-9 * matrixScale(matrix)) {
      return null;
    }
    solved[row] = value / diagonal;
  }
  const coefficients = {
    uncached: solved[0] ?? 0,
    cacheRead: solved[1] ?? 0,
    output: solved[2] ?? 0
  };
  if (
    coefficients.uncached < 0 ||
    coefficients.cacheRead < 0 ||
    coefficients.output < 0 ||
    !Number.isFinite(coefficients.uncached + coefficients.cacheRead + coefficients.output)
  ) {
    return null;
  }
  return coefficients;
}

function equalRate(tokens: PersonalQuotaTokens, meterDelta: number): PersonalQuotaCoefficients | null {
  const total = tokens.uncached + tokens.cacheRead + tokens.output;
  if (!(meterDelta > 0) || !(total > 0)) {
    return null;
  }
  const rate = meterDelta / total;
  return { uncached: rate, cacheRead: rate, output: rate };
}

export function personalQuotaCoefficients(fit: PersonalQuotaFit): PersonalQuotaCoefficients | null {
  if (fit.samples > 0) {
    const solved = solveCoefficients(fit);
    if (solved) {
      return solved;
    }
  }
  if (fit.lastTokens !== null && fit.lastMeterDelta !== null) {
    return equalRate(fit.lastTokens, fit.lastMeterDelta);
  }
  return null;
}

export function personalQuotaUsesSharedRate(fit: PersonalQuotaFit): boolean {
  return fit.samples > 0 && solveCoefficients(fit) === null && personalQuotaCoefficients(fit) !== null;
}

export function estimatePersonalQuotaPercent(
  tokens: PersonalQuotaTokens,
  coefficients: PersonalQuotaCoefficients
): number {
  return (
    coefficients.uncached * tokens.uncached +
    coefficients.cacheRead * tokens.cacheRead +
    coefficients.output * tokens.output
  );
}

export function addPersonalQuotaSample(
  fit: PersonalQuotaFit,
  tokens: PersonalQuotaTokens,
  meterDelta: number
): PersonalQuotaFit {
  const sample = [tokens.uncached, tokens.cacheRead, tokens.output];
  const xtxValues = [...fit.xtx];
  const xtyValues = [...fit.xty];
  const pairs = [
    [0, 0, 0],
    [0, 1, 1],
    [0, 2, 2],
    [1, 1, 3],
    [1, 2, 4],
    [2, 2, 5]
  ] as const;
  for (const [left, right, index] of pairs) {
    xtxValues[index] = (xtxValues[index] ?? 0) + (sample[left] ?? 0) * (sample[right] ?? 0);
  }
  for (let index = 0; index < 3; index += 1) {
    xtyValues[index] = (xtyValues[index] ?? 0) + (sample[index] ?? 0) * meterDelta;
  }
  const next: PersonalQuotaFit = {
    xtx: [
      xtxValues[0] ?? 0,
      xtxValues[1] ?? 0,
      xtxValues[2] ?? 0,
      xtxValues[3] ?? 0,
      xtxValues[4] ?? 0,
      xtxValues[5] ?? 0
    ],
    xty: [xtyValues[0] ?? 0, xtyValues[1] ?? 0, xtyValues[2] ?? 0],
    samples: fit.samples + 1,
    residual: null,
    lastTokens: tokens,
    lastMeterDelta: meterDelta
  };
  const coefficients = personalQuotaCoefficients(next);
  return {
    ...next,
    residual:
      coefficients === null ? null : estimatePersonalQuotaPercent(tokens, coefficients) - meterDelta
  };
}

export function personalQuotaAlert(input: {
  estimate: number | null;
  capPercent: number | null;
  alertedResetsAt: string | null;
  resetsAt: string | null;
}): boolean {
  if (input.estimate === null || input.capPercent === null || input.estimate < input.capPercent) {
    return false;
  }
  return input.alertedResetsAt !== (input.resetsAt ?? "");
}
