import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { installHttpSecurity } from "./http-security.js";

async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>): Promise<void> {
  const app = Fastify({ logger: false });
  installHttpSecurity(app, {
    trustedOrigins: ["http://127.0.0.1:4173"],
    localAccessToken: "test-token"
  });
  app.get("/api/overview", async () => ({ ok: true }));
  app.post("/api/sync", async () => ({ ok: true }));
  await app.ready();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe("installHttpSecurity", () => {
  it("rejects non-loopback Host", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: "example.com" }
      });
      expect(response.statusCode).toBe(403);
    });
  });

  it("rejects state-changing requests without Origin or token", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/sync",
        headers: { host: "127.0.0.1:45183" }
      });
      expect(response.statusCode).toBe(403);
    });
  });

  it("allows native callers with X-Agent-Metrics-Token", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/sync",
        headers: {
          host: "127.0.0.1:45183",
          "x-agent-metrics-token": "test-token"
        }
      });
      expect(response.statusCode).toBe(200);
    });
  });

  it("allows loopback GET from null Origin", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: "127.0.0.1:45183", origin: "null" }
      });
      expect(response.statusCode).toBe(200);
    });
  });

  it("rejects state-changing requests with null Origin unless token matches", async () => {
    await withApp(async (app) => {
      const denied = await app.inject({
        method: "POST",
        url: "/api/sync",
        headers: { host: "127.0.0.1:45183", origin: "null" }
      });
      expect(denied.statusCode).toBe(403);
      const allowed = await app.inject({
        method: "POST",
        url: "/api/sync",
        headers: {
          host: "127.0.0.1:45183",
          origin: "null",
          "x-agent-metrics-token": "test-token"
        }
      });
      expect(allowed.statusCode).toBe(200);
    });
  });

  it("sets Cache-Control no-store on telemetry GET responses", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/overview",
        headers: { host: "127.0.0.1:45183" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    });
  });
});
