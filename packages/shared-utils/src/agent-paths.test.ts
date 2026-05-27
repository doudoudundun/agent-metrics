import { describe, expect, it } from "vitest";
import { getAgentMetricsPaths } from "./agent-paths.js";

describe("getAgentMetricsPaths", () => {
  it("returns the shared agent metrics data paths from the repo root", () => {
    expect(getAgentMetricsPaths("D:/projects/dev/agent-metrics")).toEqual({
      rawHookLogPath: "D:/projects/dev/agent-metrics/data/hooks/raw/claude-code.jsonl",
      eventLogPath: "D:/projects/dev/agent-metrics/data/events/events.jsonl",
      snapshotRoot: "D:/projects/dev/agent-metrics/data/hooks/snapshots",
      parserStatePath: "D:/projects/dev/agent-metrics/data/hooks/state/parser-state.json",
      parserSeenPath: "D:/projects/dev/agent-metrics/data/hooks/state/seen-raw-ids.json",
      transcriptManifestPath: "D:/projects/dev/agent-metrics/data/hooks/state/transcript-manifest.json",
      transcriptCursorPath: "D:/projects/dev/agent-metrics/data/hooks/state/transcript-cursors.json",
      transcriptLedgerPath: "D:/projects/dev/agent-metrics/data/hooks/state/transcript-ledger.json"
    });
  });
});
