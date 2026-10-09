import { z } from "zod";

/**
 * tool_call_id is unique only within a SessionKey. Spec section 9.3.
 * Canonical forms include native:<id> and derived:<sha256...>.
 */
export const ToolCallIdSchema = z.string().min(1);

export const SessionKeySchema = z.object({
  sourceInstanceId: z.string().min(1),
  sessionId: z.string().min(1)
});

export const ToolCallKeySchema = SessionKeySchema.extend({
  toolCallId: ToolCallIdSchema
});

export type SessionKey = z.infer<typeof SessionKeySchema>;
export type ToolCallKey = z.infer<typeof ToolCallKeySchema>;
