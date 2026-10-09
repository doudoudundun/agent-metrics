import { describe, expect, it, vi } from "vitest";
import { normalizeQueryKey, QueryClient } from "./query-client";

describe("QueryClient", () => {
  it("normalizes object key order and array order", () => {
    expect(normalizeQueryKey({ source: ["cursor", "codex"], scope: { range: "day", mode: "rolling" } })).toBe(
      normalizeQueryKey({ scope: { mode: "rolling", range: "day" }, source: ["codex", "cursor"] })
    );
  });

  it("deduplicates concurrent requests for one normalized key", async () => {
    const client = new QueryClient();
    const loader = vi.fn(async () => "ok");
    const [first, second] = await Promise.all([
      client.fetch({ page: 1, filters: ["a", "b"] }, loader),
      client.fetch({ filters: ["b", "a"], page: 1 }, loader)
    ]);

    expect([first, second]).toEqual(["ok", "ok"]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(client.getState({ page: 1, filters: ["a", "b"] }).status).toBe("ready");
  });

  it("retains ready data as stale when a refresh fails", async () => {
    const client = new QueryClient();
    const loader = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("cached")
      .mockRejectedValueOnce(new Error("offline"));

    await client.fetch("overview", loader);
    await expect(client.fetch("overview", loader)).rejects.toThrow("offline");

    const state = client.getState<string>("overview");
    expect(state.status).toBe("stale");
    expect(state.data).toBe("cached");
    expect(state.error?.message).toBe("offline");
  });

  it("keeps cached data ready during a successful background refresh", async () => {
    const client = new QueryClient();
    await client.fetch("overview", async () => "cached");
    let resolveRefresh!: (value: string) => void;
    const refresh = client.fetch("overview", () => new Promise<string>((resolve) => {
      resolveRefresh = resolve;
    }));
    expect(client.getState("overview")).toMatchObject({ status: "ready", data: "cached", error: null });
    await Promise.resolve();
    resolveRefresh("fresh");
    await expect(refresh).resolves.toBe("fresh");
    expect(client.getState("overview")).toMatchObject({ status: "ready", data: "fresh" });
    client.dispose();
  });

  it("clears a cancelled request timeout even if its loader ignores abort", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    try {
      const first = client.fetch("overview", () => new Promise<string>(() => {}), { timeoutMs: 10 });
      const cancelled = expect(first).rejects.toThrow("Request cancelled.");
      await Promise.resolve();
      client.cancel("overview");
      await cancelled;

      let resolveReplacement!: (value: string) => void;
      const replacement = client.fetch("overview", () => new Promise<string>((resolve) => {
        resolveReplacement = resolve;
      }), { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(11);
      expect(client.getState("overview")).toMatchObject({ status: "loading", error: null });
      resolveReplacement("fresh");
      await expect(replacement).resolves.toBe("fresh");
      expect(client.getState("overview")).toMatchObject({ status: "ready", data: "fresh" });
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("settles pending requests and removes timers when disposed", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    try {
      const request = client.fetch("overview", () => new Promise<string>(() => {}));
      const cancelled = expect(request).rejects.toThrow("Request cancelled.");
      await Promise.resolve();
      client.dispose();
      await cancelled;
      expect(vi.getTimerCount()).toBe(0);
      expect(client.getState("overview").status).toBe("idle");
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels a request without leaving the inactive query in an error state", async () => {
    const client = new QueryClient();
    const loader = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );

    const request = client.fetch("slow", loader);
    client.cancel("slow");
    await expect(request).rejects.toThrow("Request cancelled.");
    expect(client.getState("slow").status).toBe("idle");
  });

  it("allows a replacement request to start before a cancelled request settles", async () => {
    const client = new QueryClient();
    let rejectFirst: (reason?: unknown) => void = () => undefined;
    const firstLoader = vi.fn(
      () => new Promise<string>((_, reject) => {
        rejectFirst = reject;
      })
    );

    const first = client.fetch("overview", firstLoader);
    client.cancel("overview");
    const second = client.fetch("overview", async () => "fresh");
    rejectFirst(new Error("aborted"));

    await expect(first).rejects.toThrow("Request cancelled.");
    await expect(second).resolves.toBe("fresh");
    expect(client.getState<string>("overview")).toMatchObject({
      status: "ready",
      data: "fresh",
      error: null
    });
  });

  it("does not apply a timed-out response after generation is bumped", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("late"), 20_000);
        })
    );

    const request = client.fetch("overview", loader, { timeoutMs: 10 });
    const timeoutAssertion = expect(request).rejects.toThrow("Request timed out.");
    await vi.advanceTimersByTimeAsync(11);
    await timeoutAssertion;
    expect(client.getState("overview")).toMatchObject({
      status: "error",
      data: null
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.getState("overview").status).not.toBe("ready");
    expect(client.getState<string>("overview").data).toBe(null);
    vi.useRealTimers();
  });
});
