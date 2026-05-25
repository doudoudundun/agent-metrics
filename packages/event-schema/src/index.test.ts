import { describe, expect, it } from "vitest";
import { AnyEventSchema } from "./index.js";

describe("AnyEventSchema", () => {
  it("parses a session.started event", () => {
    const result = AnyEventSchema.safeParse({
      event_id: "evt_1",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:00.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "session.started"
    });

    expect(result.success).toBe(true);
  });

  it("rejects a tool event without a tool name", () => {
    const result = AnyEventSchema.safeParse({
      event_id: "evt_2",
      session_id: "ses_1",
      timestamp: "2026-05-25T08:00:01.000Z",
      source_vendor: "claude-code",
      source_adapter: "claude",
      workspace_path: "D:/projects/dev/agent-metrics",
      type: "tool.called",
      status: "started"
    });

    expect(result.success).toBe(false);
  });
});
