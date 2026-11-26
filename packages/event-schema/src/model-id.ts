/** Remove field delimiters leaked by log metadata without changing model variants. */
export function normalizeModelId(model: string | null | undefined): string | null {
  const normalized = model?.trim().replace(/;+$/u, "").trim();
  return normalized || null;
}

export type UsageMode = "fast" | "ultrafast" | "standard" | "unknown";

/** Prefer explicit routing or named variants; unmarked usage uses standard accounting. */
export function resolveUsageMode(model: string | null | undefined, serviceTier?: string | null): UsageMode {
  const tier = serviceTier?.trim().toLowerCase();
  if (tier === "ultrafast") return "ultrafast";
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "standard" || tier === "default" || tier === "normal") return "standard";
  if (/(?:^|[-_\s])ultrafast(?:$|[-_\s])/iu.test(normalizeModelId(model) ?? "")) return "ultrafast";
  if (/(?:^|[-_\s])(?:fast|highspeed|ultraspeed)(?:$|[-_\s])/iu.test(normalizeModelId(model) ?? "")) return "fast";
  return tier ? "unknown" : "standard";
}
