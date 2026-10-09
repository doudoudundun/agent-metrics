import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  createEventId,
  deriveToolCallId,
  normalizeEventTimestamp,
  normalizeNativeId,
  normalizeWorkspacePath,
  semanticFingerprint
} from "./identity.js";

describe("v2 event identity", () => {
  it("builds the required stable source-record identity", () => {
    const eventId = createEventId({
      sourceInstanceId: "claude:default",
      sourceRecordNamespace: "hook",
      eventKind: "tool.called",
      sessionId: "session-1",
      sourceRecordId: "tool-use-1"
    });

    expect(eventId).toBe(
      "v2:claude:default:hook:tool.called:e4bb7c4fa769f598ed05b0f646f1b5b02b17a2923a7ec491ae32e27f4d9de32c"
    );
    expect(
      createEventId({
        sourceInstanceId: "claude:default",
        sourceRecordNamespace: "hook",
        eventKind: "tool.called",
        sessionId: "session-1",
        sourceRecordId: "tool-use-1"
      })
    ).toBe(eventId);
  });

  it("uses a deterministic fallback identity when the source has no native id", () => {
    expect(
      createEventId({
        sourceInstanceId: "cursor:default",
        sourceRecordNamespace: "composer",
        eventKind: "token.usage.recorded",
        sessionId: "session-1",
        timestamp: "2026-07-17T10:00:00.123Z",
        sourceSequence: 7,
        location: "generation:2"
      })
    ).toBe(
      "v2:cursor:default:composer:token.usage.recorded:b6cb364be48716ac62d903cb8724fe02140506ee840764d65ed50696bc14f487"
    );
  });

  it("normalizes timestamps and workspace paths without resolving parent segments", () => {
    expect(normalizeEventTimestamp("2026-07-17T18:00:00+08:00")).toBe(
      "2026-07-17T10:00:00.000Z"
    );
    expect(normalizeWorkspacePath("c:\\work\\.\\agent\\..\\metrics\\")).toBe(
      "C:/work/agent/../metrics"
    );
    expect(normalizeWorkspacePath("\\\\server\\share\\folder\\")).toBe(
      "//server/share/folder"
    );
    expect(normalizeWorkspacePath(undefined)).toBe(".");
  });

  it("canonicalizes object keys and derives native and fallback tool identities", () => {
    expect(canonicalizeJson({ z: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"z":1}'
    );
    expect(normalizeNativeId(" tool-1 ")).toBe("native:tool-1");
    expect(normalizeNativeId(" ")).toBeNull();
    expect(
      deriveToolCallId({
        sourceInstanceId: "claude:default",
        sessionId: "session-1",
        timestamp: "2026-07-17T10:00:00.000Z",
        sourceSequence: 2,
        toolName: "Read",
        sourceLocation: "hook:PostToolUse"
      })
    ).toMatch(/^derived:[0-9a-f]{64}$/);
  });

  it("excludes adapter provenance from the semantic fingerprint", () => {
    const first = {
      schema_version: 2 as const,
      event_id: "event-1",
      session_id: "session-1",
      timestamp: "2026-07-17T10:00:00.000Z",
      source_vendor: "claude-code" as const,
      source_adapter: "claude-hook" as const,
      source_instance_id: "claude:default",
      adapter_instance_id: "hook@claude:default",
      source_record_namespace: "hook",
      source_record_id: "tool-1",
      workspace_path: ".",
      type: "session.started" as const
    };
    const second = {
      ...first,
      source_adapter: "claude" as const,
      adapter_instance_id: "transcript@claude:default"
    };

    expect(semanticFingerprint(first)).toBe(semanticFingerprint(second));
  });
});
