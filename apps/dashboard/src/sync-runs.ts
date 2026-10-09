import type { ManualSyncResponse, SyncRunResponse } from "./api";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1_000;

type FetchSyncRun = (runId: string, signal?: AbortSignal) => Promise<SyncRunResponse>;

type WaitForSyncRunsOptions = {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

export async function waitForSyncRuns(
  acceptedRuns: ManualSyncResponse["runs"],
  fetchRun: FetchSyncRun,
  options: WaitForSyncRunsOptions = {}
): Promise<SyncRunResponse[]> {
  const pendingRunIds = new Set(acceptedRuns.map((run) => run.runId));
  const completedRuns = new Map<string, SyncRunResponse>();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const wait = options.wait ?? waitForPoll;
  const deadline = now() + timeoutMs;

  while (pendingRunIds.size > 0) {
    throwIfAborted(options.signal);
    const runs = await Promise.all(
      [...pendingRunIds].map((runId) => fetchRun(runId, options.signal))
    );

    for (const run of runs) {
      completedRuns.set(run.runId, run);
      if (isTerminal(run.status)) {
        pendingRunIds.delete(run.runId);
      }
    }

    if (pendingRunIds.size === 0) {
      return acceptedRuns.map((run) => completedRuns.get(run.runId)!).filter(Boolean);
    }
    if (now() >= deadline) {
      throw new Error("Sync run polling expired.");
    }
    await wait(pollIntervalMs, options.signal);
  }

  return [];
}

function isTerminal(status: SyncRunResponse["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "aborted";
}

function waitForPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Sync run polling cancelled.");
  error.name = "AbortError";
  return error;
}
