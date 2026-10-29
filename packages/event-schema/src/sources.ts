import { z } from "zod";

export const SourceVendorSchema = z.enum([
  "claude-code",
  "opencode",
  "zcode",
  "kimicode",
  "dsh",
  "codex",
  "cursor",
  "mimo",
  "workbuddy"
]);

export const SourceAdapterSchema = z.enum([
  "claude",
  "claude-hook",
  "claude-transcript",
  "opencode-db",
  "zcode-db",
  "kimicode-wire",
  "dsh-jsonl",
  "cursor-ide",
  "codex-rollout",
  "codex-history",
  "codex-logs",
  "mimo-db",
  "workbuddy-jsonl",
  "codebuddy-cli-log"
]);

export const UsageSourceSchema = z.enum([
  "claude-transcript",
  "opencode-message",
  "opencode-step-finish",
  "kimicode-usage",
  "dsh-usage",
  "cursor-generation",
  "cursor-composer-context",
  "cursor-official",
  "codex-rollout",
  "codex-logs",
  "workbuddy-usage",
  "codebuddy-log"
]);

export type SourceVendor = z.infer<typeof SourceVendorSchema>;
export type SourceAdapter = z.infer<typeof SourceAdapterSchema>;
export type UsageSource = z.infer<typeof UsageSourceSchema>;
