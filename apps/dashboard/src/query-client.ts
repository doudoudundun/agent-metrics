export type QueryStatus = "idle" | "loading" | "ready" | "stale" | "error";

export type QueryState<T> = {
  status: QueryStatus;
  data: T | null;
  error: Error | null;
  updatedAt: number | null;
};

export type QueryListener<T> = (state: QueryState<T>) => void;

export type QueryOptions = {
  timeoutMs?: number;
};

type QueryEntry<T> = {
  state: QueryState<T>;
  promise: Promise<T> | null;
  controller: AbortController | null;
  cancelRequest: (() => void) | null;
  generation: number;
  listeners: Set<QueryListener<T>>;
};

const DEFAULT_TIMEOUT_MS = 10_000;

export class QueryClient {
  private readonly entries = new Map<string, QueryEntry<unknown>>();

  fetch<T>(
    key: unknown,
    loader: (signal: AbortSignal) => Promise<T>,
    options: QueryOptions = {}
  ): Promise<T> {
    const normalizedKey = normalizeQueryKey(key);
    const entry = this.getOrCreateEntry<T>(normalizedKey);
    if (entry.promise !== null) {
      return entry.promise;
    }

    const controller = new AbortController();
    const generation = entry.generation + 1;
    let timedOut = false;
    let settle: {
      resolve: (value: T) => void;
      reject: (error: Error) => void;
    } | null = null;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (entry.generation !== generation) return;
      timedOut = true;
      entry.generation += 1;
      controller.abort();
      entry.promise = null;
      entry.controller = null;
      entry.cancelRequest = null;
      const timeoutError = new Error("Request timed out.");
      entry.state = {
        status: entry.state.data === null ? "error" : "stale",
        data: entry.state.data,
        error: timeoutError,
        updatedAt: entry.state.updatedAt
      };
      this.notify(entry);
      settle?.reject(timeoutError);
    }, timeoutMs);
    entry.generation = generation;
    entry.controller = controller;
    entry.cancelRequest = () => {
      clearTimeout(timeout);
      settle?.reject(new Error("Request cancelled."));
    };
    entry.state = {
      ...entry.state,
      status: entry.state.data === null ? "loading" : entry.state.status,
      error: null
    };
    this.notify(entry);

    const promise = new Promise<T>((resolve, reject) => {
      settle = { resolve, reject };
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("Request cancelled.");
        return loader(controller.signal);
      })
        .then((data) => {
          if (entry.generation === generation) {
            entry.state = {
              status: "ready",
              data,
              error: null,
              updatedAt: Date.now()
            };
            // Clear the in-flight slot before resolving so a fetch issued
            // immediately after `await` starts a fresh request instead of
            // deduping onto this settled promise.
            entry.promise = null;
            entry.controller = null;
            entry.cancelRequest = null;
            this.notify(entry);
            resolve(data);
            return;
          }
          if (!timedOut) {
            reject(toQueryError(new Error("Request cancelled."), true, timedOut));
          }
        })
        .catch((error: unknown) => {
          const normalizedError = toQueryError(error, controller.signal.aborted, timedOut);
          if (entry.generation === generation) {
            entry.state = {
              status: entry.state.data === null ? "error" : "stale",
              data: entry.state.data,
              error: normalizedError,
              updatedAt: entry.state.updatedAt
            };
            entry.promise = null;
            entry.controller = null;
            entry.cancelRequest = null;
            this.notify(entry);
          }
          if (!timedOut) {
            reject(normalizedError);
          }
        })
        .finally(() => {
          clearTimeout(timeout);
        });
    });

    entry.promise = promise;
    return promise;
  }

  subscribe<T>(key: unknown, listener: QueryListener<T>): () => void {
    const entry = this.getOrCreateEntry<T>(normalizeQueryKey(key));
    entry.listeners.add(listener as QueryListener<unknown>);
    listener(entry.state);
    return () => {
      entry.listeners.delete(listener as QueryListener<unknown>);
    };
  }

  getState<T>(key: unknown): QueryState<T> {
    const entry = this.entries.get(normalizeQueryKey(key));
    if (!entry) {
      return { status: "idle", data: null, error: null, updatedAt: null };
    }
    return entry.state as QueryState<T>;
  }

  cancel(key: unknown): void {
    const entry = this.entries.get(normalizeQueryKey(key));
    if (!entry?.controller) {
      return;
    }

    // A cancellation means this request is no longer relevant (for example,
    // because its scope changed). It must not overwrite a replacement request
    // or present an offline error to the user.
    entry.generation += 1;
    entry.controller.abort();
    entry.cancelRequest?.();
    entry.cancelRequest = null;
    entry.controller = null;
    entry.promise = null;
    entry.state = {
      ...entry.state,
      status: entry.state.data === null ? "idle" : "stale",
      error: null
    };
    this.notify(entry);
  }

  invalidate(key: unknown): void {
    const entry = this.entries.get(normalizeQueryKey(key));
    if (!entry) {
      return;
    }
    entry.state = {
      ...entry.state,
      status: entry.state.data === null ? "idle" : "stale",
      error: null
    };
    this.notify(entry);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      entry.controller?.abort();
      entry.cancelRequest?.();
      entry.cancelRequest = null;
      entry.controller = null;
      entry.promise = null;
      entry.listeners.clear();
    }
    this.entries.clear();
  }

  private getOrCreateEntry<T>(key: string): QueryEntry<T> {
    const existing = this.entries.get(key);
    if (existing) {
      return existing as QueryEntry<T>;
    }

    const entry: QueryEntry<T> = {
      state: { status: "idle", data: null, error: null, updatedAt: null },
      promise: null,
      controller: null,
      cancelRequest: null,
      generation: 0,
      listeners: new Set()
    };
    this.entries.set(key, entry as QueryEntry<unknown>);
    return entry;
  }

  private notify<T>(entry: QueryEntry<T>): void {
    const state = entry.state;
    for (const listener of entry.listeners) {
      listener(state);
    }
  }
}

export function normalizeQueryKey(value: unknown): string {
  return stableSerialize(value);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function toQueryError(error: unknown, aborted: boolean, timedOut: boolean): Error {
  if (timedOut) {
    return new Error("Request timed out.");
  }
  if (aborted) {
    return new Error("Request cancelled.");
  }
  return error instanceof Error ? error : new Error(String(error));
}
