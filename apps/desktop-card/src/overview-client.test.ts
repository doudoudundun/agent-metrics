import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOverviewUrl,
  parseOverviewMetrics,
  resolveCoreApiBaseUrl,
  fetchOverviewMetrics
} from "./overview-client.js";

describe("desktop-card overview client", () => {
  it("targets today's local core overview endpoint", () => {
    assert.equal(resolveCoreApiBaseUrl({}), "http://127.0.0.1:45183");
    assert.equal(
      buildOverviewUrl("http://127.0.0.1:45183"),
      "http://127.0.0.1:45183/api/overview?mode=calendar&range=day&sourceVendor=all"
    );
  });

  it("rejects incomplete overview payloads instead of inventing numbers", () => {
    assert.equal(parseOverviewMetrics({ totalTokens: 12 }), null);
  });

  it("maps connection failures to an explicit unavailable state", async () => {
    const result = await fetchOverviewMetrics({
      baseUrl: "http://127.0.0.1:45183",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      }
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, "unavailable");
    }
  });
});
