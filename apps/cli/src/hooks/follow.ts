import { parseRawHooksOnce } from "./parser.js";

export async function followRawHooks(input: {
  repoRoot: string;
  pollIntervalMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  while (!input.signal?.aborted) {
    await parseRawHooksOnce({ repoRoot: input.repoRoot });
    await delay(input.pollIntervalMs, input.signal);
  }
}

async function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolvePromise();
    }, durationMs);

    const handleAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      resolvePromise();
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}
