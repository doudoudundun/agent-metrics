import type { SourceVendor } from "./api";

type ConcreteSourceVendor = Exclude<SourceVendor, "all">;

/** Display labels for every agent the dashboard can report on. */
export const SOURCE_LABELS: Record<ConcreteSourceVendor, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  kimicode: "Kimi Code",
  mimo: "MiMo",
  zcode: "ZCode",
  dsh: "DSH",
  workbuddy: "WorkBuddy"
};

export function formatSourceLabel(vendor: ConcreteSourceVendor): string {
  return SOURCE_LABELS[vendor] ?? vendor;
}
