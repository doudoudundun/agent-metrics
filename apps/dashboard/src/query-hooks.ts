import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeQueryKey, QueryClient, type QueryState } from "./query-client";

export type UseQueryOptions = {
  enabled?: boolean;
  pollIntervalMs?: number;
  /** Keep polling even when the document is hidden (needed for Electron widget). */
  pollWhileHidden?: boolean;
};

export function useQuery<T>(
  client: QueryClient,
  key: unknown,
  loader: (signal: AbortSignal) => Promise<T>,
  options: UseQueryOptions = {}
): QueryState<T> & { refresh: () => Promise<T> } {
  const normalizedKey = useMemo(() => normalizeQueryKey(key), [key]);
  const [state, setState] = useState<QueryState<T>>(() => client.getState<T>(normalizedKey));
  const loaderRef = useRef(loader);
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const pollWhileHidden = options.pollWhileHidden ?? false;

  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  useEffect(() => {
    const unsubscribe = client.subscribe<T>(normalizedKey, (next) => {
      setState((current) => {
        if (next.data !== null) {
          return next;
        }
        if (
          current.data !== null &&
          (next.status === "idle" || next.status === "loading" || next.status === "stale")
        ) {
          return {
            ...next,
            status: "stale",
            data: current.data
          };
        }
        return next;
      });
    });
    return unsubscribe;
  }, [client, normalizedKey]);

  const refresh = useCallback(
    () => client.fetch<T>(normalizedKey, (signal) => loaderRef.current(signal)),
    [client, normalizedKey]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let active = true;
    let timer: number | undefined;

    const canPoll = () => active && (pollWhileHidden || document.visibilityState !== "hidden");

    const schedule = () => {
      if (!canPoll()) {
        return;
      }
      timer = window.setTimeout(async () => {
        if (!canPoll()) {
          return;
        }
        try {
          await refresh();
        } catch {
          // The query retains its last successful data and retries at the next poll.
        }
        schedule();
      }, pollIntervalMs);
    };

    const loadImmediately = () => {
      if (!canPoll()) {
        return;
      }
      void refresh().catch(() => undefined).finally(schedule);
    };
    const handleVisibility = () => {
      if (pollWhileHidden) {
        return;
      }
      if (document.visibilityState === "visible") {
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
        loadImmediately();
      } else if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    loadImmediately();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", handleVisibility);
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      client.cancel(normalizedKey);
    };
  }, [client, enabled, normalizedKey, pollIntervalMs, pollWhileHidden, refresh]);

  return { ...state, refresh };
}
