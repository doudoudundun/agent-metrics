import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadEventLedger,
  rebuildEventLedgerFromLog,
  persistEventLedger,
  loadEventLedgerWithFallback
} from "./ledger.js";

describe("ledger utilities", () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("loadEventLedger", () => {
    it("returns empty Set when ledger file is missing", async () => {
      const result = await loadEventLedger(join(root, "missing-ledger.json"));
      expect(result).toEqual(new Set());
    });

    it("returns empty Set when ledger file has invalid JSON", async () => {
      const ledgerPath = join(root, "bad.json");
      await writeFile(ledgerPath, "not json {{{");
      const result = await loadEventLedger(ledgerPath);
      expect(result).toEqual(new Set());
    });

    it("returns empty Set when ledger has no eventIds field", async () => {
      const ledgerPath = join(root, "no-ids.json");
      await writeFile(ledgerPath, JSON.stringify({ otherField: [] }));
      const result = await loadEventLedger(ledgerPath);
      expect(result).toEqual(new Set());
    });

    it("loads valid event IDs from ledger", async () => {
      const ledgerPath = join(root, "ledger.json");
      await writeFile(ledgerPath, JSON.stringify({ eventIds: ["a:1", "b:2", "c:3"] }));
      const result = await loadEventLedger(ledgerPath);
      expect(result).toEqual(new Set(["a:1", "b:2", "c:3"]));
    });

    it("filters out non-string entries", async () => {
      const ledgerPath = join(root, "mixed.json");
      await writeFile(ledgerPath, JSON.stringify({ eventIds: ["a:1", 42, null, "b:2"] }));
      const result = await loadEventLedger(ledgerPath);
      expect(result).toEqual(new Set(["a:1", "b:2"]));
    });
  });

  describe("rebuildEventLedgerFromLog", () => {
    it("returns empty Set when event log is missing", async () => {
      const result = await rebuildEventLedgerFromLog(join(root, "missing.jsonl"), "prefix:");
      expect(result).toEqual(new Set());
    });

    it("rebuilds event IDs matching prefix from event log", async () => {
      const eventLogPath = join(root, "events.jsonl");
      await writeFile(
        eventLogPath,
        [
          JSON.stringify({ event_id: "opencode:session:abc:started", type: "session.started" }),
          JSON.stringify({ event_id: "cursor:session:xyz:started", type: "session.started" }),
          JSON.stringify({ event_id: "opencode:prompt:def", type: "prompt.submitted" }),
          "malformed line that is not json",
          JSON.stringify({ event_id: "opencode:usage:def", type: "token.usage.recorded" })
        ].join("\n")
      );

      const result = await rebuildEventLedgerFromLog(eventLogPath, "opencode:");
      expect(result).toEqual(
        new Set([
          "opencode:session:abc:started",
          "opencode:prompt:def",
          "opencode:usage:def"
        ])
      );
    });

    it("skips malformed lines without error", async () => {
      const eventLogPath = join(root, "events.jsonl");
      await writeFile(
        eventLogPath,
        [
          JSON.stringify({ event_id: "prefix:a" }),
          "{broken json",
          "",
          JSON.stringify({ event_id: "prefix:b" }),
          "also not json"
        ].join("\n")
      );

      const result = await rebuildEventLedgerFromLog(eventLogPath, "prefix:");
      expect(result).toEqual(new Set(["prefix:a", "prefix:b"]));
    });
  });

  describe("persistEventLedger", () => {
    it("writes sorted event IDs to ledger file", async () => {
      const ledgerPath = join(root, "ledger.json");
      const eventIds = new Set(["c:3", "a:1", "b:2"]);
      await persistEventLedger(ledgerPath, eventIds);

      const contents = await readFile(ledgerPath, "utf8");
      const parsed = JSON.parse(contents);
      expect(parsed).toEqual({ eventIds: ["a:1", "b:2", "c:3"] });
    });
  });

  describe("loadEventLedgerWithFallback", () => {
    it("returns ledger IDs directly when ledger exists and has entries", async () => {
      const ledgerPath = join(root, "ledger.json");
      const eventLogPath = join(root, "events.jsonl");
      await writeFile(ledgerPath, JSON.stringify({ eventIds: ["opencode:a", "opencode:b"] }));
      await writeFile(eventLogPath, JSON.stringify({ event_id: "opencode:c" }) + "\n");

      const result = await loadEventLedgerWithFallback({
        ledgerPath,
        eventLogPath,
        prefix: "opencode:"
      });

      expect(result).toEqual(new Set(["opencode:a", "opencode:b"]));
    });

    it("falls back to scanning event log when ledger is missing and persists result", async () => {
      const ledgerPath = join(root, "ledger.json");
      const eventLogPath = join(root, "events.jsonl");
      await writeFile(
        eventLogPath,
        [
          JSON.stringify({ event_id: "opencode:x" }),
          JSON.stringify({ event_id: "other:y" }),
          JSON.stringify({ event_id: "opencode:z" })
        ].join("\n")
      );

      const result = await loadEventLedgerWithFallback({
        ledgerPath,
        eventLogPath,
        prefix: "opencode:"
      });

      expect(result).toEqual(new Set(["opencode:x", "opencode:z"]));

      // Verify the rebuilt ledger was persisted
      const persisted = await readFile(ledgerPath, "utf8");
      expect(JSON.parse(persisted)).toEqual({ eventIds: ["opencode:x", "opencode:z"] });
    });

    it("falls back when ledger exists but is empty and persists rebuilt result", async () => {
      const ledgerPath = join(root, "ledger.json");
      const eventLogPath = join(root, "events.jsonl");
      await writeFile(ledgerPath, JSON.stringify({ eventIds: [] }));
      await writeFile(
        eventLogPath,
        JSON.stringify({ event_id: "codex:abc" }) + "\n"
      );

      const result = await loadEventLedgerWithFallback({
        ledgerPath,
        eventLogPath,
        prefix: "codex:"
      });

      expect(result).toEqual(new Set(["codex:abc"]));

      const persisted = await readFile(ledgerPath, "utf8");
      expect(JSON.parse(persisted)).toEqual({ eventIds: ["codex:abc"] });
    });

    it("returns empty Set when both ledger and event log are missing", async () => {
      const result = await loadEventLedgerWithFallback({
        ledgerPath: join(root, "no-ledger.json"),
        eventLogPath: join(root, "no-log.jsonl"),
        prefix: "prefix:"
      });

      expect(result).toEqual(new Set());
    });
  });
});
