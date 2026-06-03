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
      transcriptLedgerPath: "D:/projects/dev/agent-metrics/data/hooks/state/transcript-ledger.json",
      opencodeCursorPath: "D:/projects/dev/agent-metrics/data/sources/state/opencode-cursor.json",
      opencodeLedgerPath: "D:/projects/dev/agent-metrics/data/sources/state/opencode-ledger.json",
      cursorIdeStatePath: "D:/projects/dev/agent-metrics/data/sources/state/cursor-ide-state.json",
      cursorIdeLedgerPath: "D:/projects/dev/agent-metrics/data/sources/state/cursor-ide-ledger.json",
      codexCursorPath: "D:/projects/dev/agent-metrics/data/sources/state/codex-cursor.json",
      codexLedgerPath: "D:/projects/dev/agent-metrics/data/sources/state/codex-ledger.json"
    });
  });

  it("preserves native Windows separators for drive-letter roots", () => {
    expect(getAgentMetricsPaths("D:\\projects\\dev\\agent-metrics")).toEqual({
      rawHookLogPath: "D:\\projects\\dev\\agent-metrics\\data\\hooks\\raw\\claude-code.jsonl",
      eventLogPath: "D:\\projects\\dev\\agent-metrics\\data\\events\\events.jsonl",
      snapshotRoot: "D:\\projects\\dev\\agent-metrics\\data\\hooks\\snapshots",
      parserStatePath: "D:\\projects\\dev\\agent-metrics\\data\\hooks\\state\\parser-state.json",
      parserSeenPath: "D:\\projects\\dev\\agent-metrics\\data\\hooks\\state\\seen-raw-ids.json",
      transcriptManifestPath:
        "D:\\projects\\dev\\agent-metrics\\data\\hooks\\state\\transcript-manifest.json",
      transcriptCursorPath:
        "D:\\projects\\dev\\agent-metrics\\data\\hooks\\state\\transcript-cursors.json",
      transcriptLedgerPath:
        "D:\\projects\\dev\\agent-metrics\\data\\hooks\\state\\transcript-ledger.json",
      opencodeCursorPath:
        "D:\\projects\\dev\\agent-metrics\\data\\sources\\state\\opencode-cursor.json",
      opencodeLedgerPath:
        "D:\\projects\\dev\\agent-metrics\\data\\sources\\state\\opencode-ledger.json",
      cursorIdeStatePath:
        "D:\\projects\\dev\\agent-metrics\\data\\sources\\state\\cursor-ide-state.json",
      cursorIdeLedgerPath:
        "D:\\projects\\dev\\agent-metrics\\data\\sources\\state\\cursor-ide-ledger.json",
      codexCursorPath:
        "D:\\projects\\dev\\agent-metrics\\data\\sources\\state\\codex-cursor.json",
      codexLedgerPath:
        "D:\\projects\\dev\\agent-metrics\\data\\sources\\state\\codex-ledger.json"
    });
  });

  it("preserves UNC roots without rewriting their leading separators", () => {
    expect(getAgentMetricsPaths("\\\\server\\share\\repo")).toEqual({
      rawHookLogPath: "\\\\server\\share\\repo\\data\\hooks\\raw\\claude-code.jsonl",
      eventLogPath: "\\\\server\\share\\repo\\data\\events\\events.jsonl",
      snapshotRoot: "\\\\server\\share\\repo\\data\\hooks\\snapshots",
      parserStatePath: "\\\\server\\share\\repo\\data\\hooks\\state\\parser-state.json",
      parserSeenPath: "\\\\server\\share\\repo\\data\\hooks\\state\\seen-raw-ids.json",
      transcriptManifestPath:
        "\\\\server\\share\\repo\\data\\hooks\\state\\transcript-manifest.json",
      transcriptCursorPath:
        "\\\\server\\share\\repo\\data\\hooks\\state\\transcript-cursors.json",
      transcriptLedgerPath:
        "\\\\server\\share\\repo\\data\\hooks\\state\\transcript-ledger.json",
      opencodeCursorPath:
        "\\\\server\\share\\repo\\data\\sources\\state\\opencode-cursor.json",
      opencodeLedgerPath:
        "\\\\server\\share\\repo\\data\\sources\\state\\opencode-ledger.json",
      cursorIdeStatePath:
        "\\\\server\\share\\repo\\data\\sources\\state\\cursor-ide-state.json",
      cursorIdeLedgerPath:
        "\\\\server\\share\\repo\\data\\sources\\state\\cursor-ide-ledger.json",
      codexCursorPath:
        "\\\\server\\share\\repo\\data\\sources\\state\\codex-cursor.json",
      codexLedgerPath:
        "\\\\server\\share\\repo\\data\\sources\\state\\codex-ledger.json"
    });
  });
});
