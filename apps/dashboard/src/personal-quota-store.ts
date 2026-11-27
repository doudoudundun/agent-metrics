import {
  addPersonalQuotaSample,
  emptyPersonalQuotaFit,
  estimatePersonalQuotaPercent,
  personalQuotaAlert,
  personalQuotaCoefficients,
  subtractPersonalQuotaTokens,
  type PersonalQuotaFamily,
  type PersonalQuotaFit,
  type PersonalQuotaTokens
} from "@agent-metrics/contracts";

const STORAGE_KEY = "agent-metrics.personal-quota.v1";

export type PersonalQuotaCalibration = {
  tokens: PersonalQuotaTokens;
  usedPercent: number;
  resetsAt: string | null;
};

export type PersonalQuotaLine = {
  capPercent: number | null;
  fit: PersonalQuotaFit;
  calibration: PersonalQuotaCalibration | null;
  alertedResetsAt: string | null;
};

type StoredLines = Record<string, PersonalQuotaLine>;

export function emptyPersonalQuotaLine(): PersonalQuotaLine {
  return {
    capPercent: null,
    fit: emptyPersonalQuotaFit(),
    calibration: null,
    alertedResetsAt: null
  };
}

export function readPersonalQuotaLines(storage: Storage = localStorage): StoredLines {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as StoredLines;
  } catch {
    return {};
  }
}

export function writePersonalQuotaLines(lines: StoredLines, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(lines));
}

export function personalQuotaEstimate(family: PersonalQuotaFamily, line: PersonalQuotaLine): number | null {
  const coefficients = personalQuotaCoefficients(line.fit);
  return coefficients === null ? null : estimatePersonalQuotaPercent(family.tokens, coefficients);
}

export function finishPersonalQuotaStretch(
  line: PersonalQuotaLine,
  family: PersonalQuotaFamily
): { ok: true; line: PersonalQuotaLine } | { ok: false; reason: "idle" | "reset" | "meter" | "tokens" } {
  const calibration = line.calibration;
  if (calibration === null) {
    return { ok: false, reason: "idle" };
  }
  if (calibration.resetsAt !== family.resetsAt) {
    return { ok: false, reason: "reset" };
  }
  const meterDelta = family.accountUsedPercent - calibration.usedPercent;
  if (!(meterDelta > 0)) {
    return { ok: false, reason: "meter" };
  }
  const tokens = subtractPersonalQuotaTokens(family.tokens, calibration.tokens);
  if (tokens === null) {
    return { ok: false, reason: "tokens" };
  }
  return {
    ok: true,
    line: {
      ...line,
      calibration: null,
      fit: addPersonalQuotaSample(line.fit, tokens, meterDelta)
    }
  };
}

export function personalLineShouldAlert(family: PersonalQuotaFamily, line: PersonalQuotaLine): boolean {
  return personalQuotaAlert({
    estimate: personalQuotaEstimate(family, line),
    capPercent: line.capPercent,
    alertedResetsAt: line.alertedResetsAt,
    resetsAt: family.resetsAt
  });
}
