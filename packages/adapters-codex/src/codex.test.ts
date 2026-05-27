import { describe, expect, it } from "vitest";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import { extractCodexEventsFromRollout } from "./codex.js";

describe("extractCodexEventsFromRollout", () => {
  it("maps session and token snapshots into normalized Codex events", () => {
    const events = extractCodexEventsFromRollout({
      filePath: "C:/Users/test/.codex/sessions/2026/05/27/rollout-2026-05-27T10-00-00-019e5dc9-b10c-7371-8edd-066e8db7e50d.jsonl",
      sessionModels: {
        "019e5dc9-b10c-7371-8edd-066e8db7e50d": "gpt-5.4"
      },
      providerConfigs: {
        ai: {
          baseUrl: "https://api.psydo.top",
          host: "api.psydo.top"
        }
      },
      contents: [
        JSON.stringify({
          timestamp: "2026-05-27T10:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
            timestamp: "2026-05-27T10:00:00.000Z",
            cwd: "D:/projects/dev",
            model_provider: "ai"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-27T10:00:12.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 29619,
                cached_input_tokens: 6912,
                output_tokens: 702,
                reasoning_output_tokens: 333,
                total_tokens: 30321
              },
              last_token_usage: {
                input_tokens: 15928,
                cached_input_tokens: 3456,
                output_tokens: 202,
                reasoning_output_tokens: 37,
                total_tokens: 16130
              }
            }
          }
        })
      ].join("\n")
    });

    expect(events).toEqual([
      expect.objectContaining({
        event_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:started",
        session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
        source_vendor: "codex",
        source_adapter: "codex-rollout",
        type: "session.started"
      }),
      expect.objectContaining({
        event_id: "codex:session:019e5dc9-b10c-7371-8edd-066e8db7e50d:usage:30321",
        session_id: "019e5dc9-b10c-7371-8edd-066e8db7e50d",
        type: "token.usage.recorded",
        message_id: "usage_30321",
        model: "gpt-5.4",
        input_tokens: 15928,
        output_tokens: 239,
        cache_read_input_tokens: 3456,
        cache_creation_input_tokens: 0,
        usage_source: "codex-rollout",
        provider_id: "ai",
        provider_base_url: "https://api.psydo.top",
        provider_host: "api.psydo.top"
      })
    ]);

    for (const event of events) {
      expect(AnyEventSchema.safeParse(event).success).toBe(true);
    }
  });
});
