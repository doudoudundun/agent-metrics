import { ApiErrorCode, ApiErrorResponseSchema } from "@agent-metrics/contracts";
import type { FastifyInstance } from "fastify";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type HttpSecurityOptions = {
  trustedOrigins?: readonly string[];
  /**
   * Unguessable startup token for native/non-browser callers.
   * Sent as `X-Agent-Metrics-Token`. Spec section 13.2.
   */
  localAccessToken?: string;
};

export function installHttpSecurity(
  app: FastifyInstance,
  trustedOriginsOrOptions: readonly string[] | HttpSecurityOptions | undefined
): void {
  const options: HttpSecurityOptions = normalizeHttpSecurityOptions(trustedOriginsOrOptions);

  const allowedOrigins = new Set(
    options.trustedOrigins ?? [
      "http://127.0.0.1:4173",
      "http://localhost:4173",
      "http://127.0.0.1",
      "http://localhost"
    ]
  );
  const localAccessToken = options.localAccessToken ?? process.env.AGENT_METRICS_LOCAL_TOKEN;

  app.addHook("onRequest", async (request: any, reply: any) => {
    const host = request.headers.host;
    if (host !== undefined && !isLoopbackHost(host)) {
      return sendForbidden(reply, request.id, "Untrusted local request host.");
    }

    const originHeader = request.headers.origin;
    const originValue = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    const hasOrigin = typeof originValue === "string";
    const tokenHeader = request.headers["x-agent-metrics-token"];
    const tokenValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const hasValidToken =
      typeof localAccessToken === "string" &&
      localAccessToken.length > 0 &&
      tokenValue === localAccessToken;

    const isNullOrigin = originValue === "null";
    const isAllowlistedOrigin = hasOrigin && !isNullOrigin && allowedOrigins.has(originValue);

    // GET: missing Origin, file:// (`null`), and allowlisted browser origins are fine.
    // A concrete untrusted Origin is still rejected so a remote page cannot read the API.
    if (hasOrigin && !isNullOrigin && !isAllowlistedOrigin && !hasValidToken) {
      return sendForbidden(reply, request.id, "Untrusted local request origin.");
    }

    if (STATE_CHANGING_METHODS.has(String(request.method).toUpperCase())) {
      // Browser callers must present a trusted Origin. Native / file:// callers may use the token.
      if (!hasValidToken && !isAllowlistedOrigin) {
        return sendForbidden(
          reply,
          request.id,
          "State-changing requests require a trusted Origin or access token."
        );
      }
    }
  });

  app.addHook("onSend", async (request: any, reply: any, payload: unknown) => {
    const url = String(request.url ?? "");
    if (
      String(request.method).toUpperCase() === "GET" &&
      url.startsWith("/api/") &&
      url !== "/api/health"
    ) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });
}

function normalizeHttpSecurityOptions(
  trustedOriginsOrOptions: readonly string[] | HttpSecurityOptions | undefined
): HttpSecurityOptions {
  if (trustedOriginsOrOptions === undefined) {
    return {};
  }
  if (Array.isArray(trustedOriginsOrOptions)) {
    return { trustedOrigins: trustedOriginsOrOptions };
  }
  return trustedOriginsOrOptions as HttpSecurityOptions;
}

function sendForbidden(reply: any, requestId: string, message: string) {
  reply.code(403);
  return reply.send(
    ApiErrorResponseSchema.parse({
      error: {
        code: ApiErrorCode.INVALID_REQUEST,
        message,
        requestId
      }
    })
  );
}

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return (
    value === "localhost" ||
    value.startsWith("localhost:") ||
    value === "127.0.0.1" ||
    value.startsWith("127.0.0.1:") ||
    value === "[::1]" ||
    value.startsWith("[::1]:") ||
    value === "::1"
  );
}
