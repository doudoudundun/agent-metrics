export function createRecentResultAction(
  action: () => Promise<void>,
  ttlMs: number
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let lastCompletedAt = 0;

  return async () => {
    const now = Date.now();

    if (inFlight) {
      await inFlight;
      return;
    }

    if (lastCompletedAt > 0 && now - lastCompletedAt < ttlMs) {
      return;
    }

    const run = action().finally(() => {
      if (inFlight === run) {
        inFlight = null;
      }
    });

    inFlight = run;
    await run;
    lastCompletedAt = Date.now();
  };
}
