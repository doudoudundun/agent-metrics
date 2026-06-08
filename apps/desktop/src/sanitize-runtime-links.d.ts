declare module "../scripts/sanitize-runtime-links.mjs" {
  export function sanitizeRuntimeLinks(rootDir: string): Promise<string[]>;
}
