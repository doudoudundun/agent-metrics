import { z } from "zod";

/**
 * GET /api/health. Spec section 13.1.
 */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  apiVersion: z.literal(2),
  eventSchemaVersion: z.literal(2)
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
