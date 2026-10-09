import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "./query-client";
import { useQuery } from "./query-hooks";

describe("useQuery", () => {
  it("keeps the previous successful data as stale when the key changes", async () => {
    const client = new QueryClient();
    let resolveSecond: (value: string) => void = () => {
      throw new Error("Resolver was not initialized.");
    };
    const loader = vi.fn(async (signal: AbortSignal) => {
      void signal;
      if (loader.mock.calls.length === 1) {
        return "first";
      }
      return new Promise<string>((resolve) => {
        resolveSecond = resolve;
      });
    });

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useQuery<string>(client, key, loader),
      { initialProps: { key: "day" } }
    );

    await waitFor(() => expect(result.current.data).toBe("first"));

    rerender({ key: "week" });
    await waitFor(() => expect(result.current.status).toBe("stale"));
    expect(result.current.data).toBe("first");

    resolveSecond("second");
    await waitFor(() => expect(result.current.data).toBe("second"));
    expect(result.current.status).toBe("ready");
  });
});
