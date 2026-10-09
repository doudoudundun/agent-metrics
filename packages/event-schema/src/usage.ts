import { z } from "zod";

export const InputTokenSemanticsSchema = z.enum(["delta", "gross"]);
export const UsageMeasurementSchema = z.enum(["increment", "session-context-snapshot"]);

/**
 * server_tool_use is a serialized JSON object. Numeric counters, when present,
 * must be finite non-negative integers. Spec section 9.5.
 */
export const ServerToolUseSchema = z
  .string()
  .superRefine((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server_tool_use must be a JSON object string"
      });
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server_tool_use must parse as a JSON object"
      });
      return;
    }

    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === "number") {
        if (!Number.isFinite(entry) || !Number.isInteger(entry) || entry < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `server_tool_use.${key} must be a finite non-negative integer when present`
          });
        }
      }
    }
  });

export type InputTokenSemantics = z.infer<typeof InputTokenSemanticsSchema>;
export type UsageMeasurement = z.infer<typeof UsageMeasurementSchema>;

/**
 * Exhaustive usage semantics registry shared by adapters, legacy replay, and
 * aggregate code. A new usage source requires a schema revision and migration.
 */
export const USAGE_SOURCE_SEMANTICS: Record<
  z.infer<typeof import("./sources.js").UsageSourceSchema>,
  {
    inputTokenSemantics: InputTokenSemantics;
    usageMeasurement: UsageMeasurement;
  }
> = {
  "claude-transcript": { inputTokenSemantics: "delta", usageMeasurement: "increment" },
  "opencode-message": { inputTokenSemantics: "gross", usageMeasurement: "increment" },
  "opencode-step-finish": { inputTokenSemantics: "gross", usageMeasurement: "increment" },
  "kimicode-usage": { inputTokenSemantics: "delta", usageMeasurement: "increment" },
  "dsh-usage": { inputTokenSemantics: "delta", usageMeasurement: "increment" },
  "cursor-generation": { inputTokenSemantics: "delta", usageMeasurement: "increment" },
  "cursor-composer-context": {
    inputTokenSemantics: "delta",
    usageMeasurement: "session-context-snapshot"
  },
  "cursor-official": { inputTokenSemantics: "delta", usageMeasurement: "increment" },
  "codex-rollout": { inputTokenSemantics: "gross", usageMeasurement: "increment" },
  "codex-logs": { inputTokenSemantics: "gross", usageMeasurement: "increment" }
};
