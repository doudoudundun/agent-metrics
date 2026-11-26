import { createReadStream } from "node:fs";
import { copyFile, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticFingerprint } from "../packages/event-schema/dist/index.js";
import { createEventLogCursor } from "../apps/core/dist/raw-ingest.js";

const require = createRequire(new URL("../apps/core/package.json", import.meta.url));
const Database = require("better-sqlite3");

// Raw rollouts can contain enormous image/tool records. Skip those records in
// bounded memory; token_count metadata itself is small. Event logs must never
// silently skip a line while being rewritten.
async function* lines(path, allowOversized = false) {
  let fragments = [], length = 0, oversized = false;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end === -1 ? chunk.length : end + 1);
      length += part.length;
      if (length > 16 * 1024 * 1024) {
        if (!allowOversized) throw new Error(`Oversized event-log record: ${path}`);
        oversized = true;
        fragments = [];
      } else if (!oversized) fragments.push(part);
      if (end === -1) break;
      if (!oversized) yield Buffer.concat(fragments, length);
      fragments = []; length = 0; oversized = false;
      start = end + 1;
    }
  }
  if (length && !oversized) yield Buffer.concat(fragments, length);
}

function nativeId(event) { return event.source_record_id ?? event.event_id; }

function patchEvent(event, facts) {
  if (event.type !== "token.usage.recorded" || event.source_vendor !== "codex") return null;
  const fact = facts.get(nativeId(event));
  if (!fact || event.output_tokens === fact.output) return null;
  if (event.output_tokens !== fact.output + fact.reasoning || event.input_tokens !== fact.input) {
    throw new Error(`Unexpected stored counters for ${nativeId(event)}`);
  }
  return { ...event, output_tokens: fact.output };
}

function summarize(rows, facts, since) {
  const groups = new Map();
  for (const row of rows) {
    if (since && row.occurred_at < since) continue;
    const key = `${row.source_vendor}/${row.model_id ?? "unknown"}`;
    const g = groups.get(key) ?? { samples: 0, matched: 0, outputBefore: 0, outputAfter: 0, timedBefore: 0, timedAfter: 0, decodeMs: 0 };
    const corrected = facts.get(row.source_record_id)?.output ?? row.output_tokens;
    g.samples++; g.matched += facts.has(row.source_record_id) ? 1 : 0;
    g.outputBefore += row.output_tokens; g.outputAfter += corrected;
    if (row.decode_duration_ms > 0) {
      g.decodeMs += row.decode_duration_ms;
      g.timedBefore += row.output_tokens; g.timedAfter += corrected;
    }
    groups.set(key, g);
  }
  return Object.fromEntries([...groups].map(([key, g]) => [key, {
    samples: g.samples, matched: g.matched, outputBefore: g.outputBefore, outputAfter: g.outputAfter,
    speedBefore: g.decodeMs ? g.timedBefore * 1000 / g.decodeMs : null,
    speedAfter: g.decodeMs ? g.timedAfter * 1000 / g.decodeMs : null
  }]));
}

/** Dry-run by default. Apply only with the desktop stopped and an existing backup. */
export async function repairCodexOutputHistory({ dataRoot, apply = false, backupDir, rolloutPaths, since, onProgress = () => {} }) {
  const dbPath = join(dataRoot, "data/sqlite/metrics.sqlite");
  const logPath = join(dataRoot, "data/events/events.jsonl");
  const cursorPath = join(dataRoot, "data/sources/state/codex-cursor.json");
  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  let originalLog, originalCursor, swapped = false;
  try {
    const rows = db.prepare(`SELECT u.*, n.source_record_id, n.timestamp, n.payload_json
      FROM usage_events u JOIN normalized_events n ON n.event_id = u.event_id
      WHERE u.source_vendor = 'codex' AND u.usage_source = 'codex-rollout'`).all();
    const byNative = new Map();
    for (const row of rows) {
      const list = byNative.get(row.source_record_id) ?? [];
      list.push(row); byNative.set(row.source_record_id, list);
    }
    const cursor = JSON.parse(await readFile(cursorPath, "utf8"));
    const sourcePaths = [...new Set(rolloutPaths ?? Object.keys(cursor.rolloutFiles ?? {}))];
    const pending = [];
    for (const file of Object.values(cursor.rolloutFiles ?? {})) {
      for (const event of file.parserState?.pendingEvents ?? []) {
        if (event.type !== "token.usage.recorded") continue;
        pending.push(event);
        if (!byNative.has(nativeId(event))) byNative.set(nativeId(event), [{ timestamp: event.timestamp, raw_input_tokens: event.input_tokens, output_tokens: event.output_tokens }]);
      }
    }
    const facts = new Map(), ambiguous = new Set();
    let missingFiles = 0, scannedFiles = 0;
    const logStat = await stat(logPath);
    for (const path of sourcePaths) {
      let sessionId = basename(path, ".jsonl").slice(-36);
      try {
        for await (const raw of lines(path, true)) {
          if (!raw.includes('"token_count"') && !raw.includes('"session_meta"')) continue;
          let record;
          try { record = JSON.parse(raw.toString("utf8")); } catch { continue; }
          if (record.type === "session_meta") { sessionId = record.payload?.id ?? sessionId; continue; }
          if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;
          const info = record.payload.info, usage = info?.last_token_usage;
          const total = info?.total_token_usage?.total_tokens ?? usage?.total_tokens;
          if (!usage || !Number.isSafeInteger(total) || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) continue;
          const key = `codex:session:${sessionId}:usage:${total}`;
          const targets = byNative.get(key);
          if (!targets) continue;
          const output = usage.output_tokens, reasoning = usage.reasoning_output_tokens ?? 0, input = usage.input_tokens ?? 0;
          if (!Number.isSafeInteger(reasoning) || reasoning < 0 || !targets.some(t =>
            Date.parse(t.timestamp) === Date.parse(record.timestamp) && t.raw_input_tokens === input &&
            (t.output_tokens === output || t.output_tokens === output + reasoning))) continue;
          const previous = facts.get(key);
          if (previous && (previous.output !== output || previous.input !== input)) ambiguous.add(key);
          else facts.set(key, { output, reasoning, input });
        }
        scannedFiles++;
      } catch (error) { if (error.code === "ENOENT") missingFiles++; else throw error; }
      if ((scannedFiles + missingFiles) % 100 === 0) onProgress({ scannedFiles, missingFiles, matched: facts.size });
    }
    for (const key of ambiguous) facts.delete(key);
    const changes = rows.filter(r => facts.has(r.source_record_id) && r.output_tokens !== facts.get(r.source_record_id).output);
    const report = {
      applied: false, scannedFiles, missingFiles, ambiguous: ambiguous.size,
      rows: rows.length, matched: rows.filter(r => facts.has(r.source_record_id)).length,
      unmatchedRows: rows.filter(r => !facts.has(r.source_record_id)).length,
      correctedRows: changes.length, removedDuplicateTokens: changes.reduce((n, r) => n + r.output_tokens - facts.get(r.source_record_id).output, 0),
      models: summarize(rows, facts, since)
    };
    if (!apply) return report;
    if (!changes.length && pending.every(event => !patchEvent(event, facts))) {
      return { ...report, applied: true, patchedLogRows: 0, cursorChanges: 0 };
    }
    if (!backupDir) throw new Error("An existing backupDir is required for apply");
    await stat(join(backupDir, "metrics.sqlite"));
    await stat(join(backupDir, "events.jsonl"));
    const currentStat = await stat(logPath);
    if (currentStat.size !== logStat.size || currentStat.mtimeMs !== logStat.mtimeMs) throw new Error("Event log changed during scan; stop the desktop first");
    const state = db.prepare("SELECT * FROM ingestion_state WHERE stream_name = 'events.jsonl'").get();
    if (!state || state.offset_bytes !== logStat.size) throw new Error("Ingestion must be caught up before repair");

    const nextPath = `${logPath}.output-repair-${process.pid}.tmp`;
    const writer = await open(nextPath, "wx");
    let patchedLogRows = 0;
    let writeParts = [], writeBytes = 0;
    const flush = async () => {
      if (!writeBytes) return;
      await writer.writeFile(Buffer.concat(writeParts, writeBytes));
      writeParts = []; writeBytes = 0;
    };
    try {
      for await (const raw of lines(logPath)) {
        let next = raw;
        if (raw.includes('"token.usage.recorded"') && raw.includes('"codex"')) {
          const event = JSON.parse(raw.toString("utf8"));
          const corrected = patchEvent(event, facts);
          if (corrected) {
            // Keep byte offsets stable. JSON permits whitespace after a number.
            const replaced = raw.toString("utf8").replace(/("output_tokens"\s*:\s*)(\d+)/u, (_, prefix, number) => {
              const value = String(corrected.output_tokens);
              if (value.length > number.length) throw new Error("Repair would grow a counter");
              return prefix + value.padEnd(number.length, " ");
            });
            next = Buffer.from(replaced);
            if (next.length !== raw.length || JSON.parse(replaced).output_tokens !== corrected.output_tokens) throw new Error("Unsafe event-log patch");
            patchedLogRows++;
          }
        }
        writeParts.push(next); writeBytes += next.length;
        if (writeBytes >= 1024 * 1024) await flush();
      }
      await flush();
      await writer.sync();
    } finally { await writer.close(); }

    let cursorChanges = 0;
    for (const file of Object.values(cursor.rolloutFiles ?? {})) {
      if (!file.parserState?.pendingEvents) continue;
      file.parserState.pendingEvents = file.parserState.pendingEvents.map(event => {
        const patched = patchEvent(event, facts);
        if (patched) cursorChanges++;
        return patched ?? event;
      });
    }
    const payloads = changes.map(row => {
      const event = JSON.parse(row.payload_json);
      const corrected = patchEvent(event, facts);
      if (!corrected) throw new Error(`Canonical payload mismatch: ${row.event_id}`);
      return { row, event: corrected, fingerprint: semanticFingerprint(corrected) };
    });
    originalLog = join(backupDir, "events.original-inode.jsonl");
    originalCursor = join(backupDir, "codex-cursor.before-apply.json");
    await copyFile(cursorPath, originalCursor);
    await rename(logPath, originalLog);
    try { await rename(nextPath, logPath); } catch (e) { await rename(originalLog, logPath); throw e; }
    swapped = true;
    const identity = await createEventLogCursor(logPath, state.offset_bytes);
    const updatedStat = await stat(logPath);
    if (cursorChanges) await writeFile(cursorPath, JSON.stringify(cursor, null, 2));
    db.transaction(() => {
      const normalized = db.prepare("UPDATE normalized_events SET payload_json = ?, semantic_fingerprint = ? WHERE event_id = ?");
      const usage = db.prepare("UPDATE usage_events SET output_tokens = ?, semantic_fingerprint = ? WHERE event_id = ?");
      const legacy = db.prepare("UPDATE token_usage_events SET output_tokens = ? WHERE event_id = ?");
      const observations = db.prepare("UPDATE event_observations SET semantic_fingerprint = ? WHERE event_id = ? AND semantic_fingerprint = ?");
      for (const { row, event, fingerprint } of payloads) {
        normalized.run(JSON.stringify(event), fingerprint, row.event_id);
        usage.run(event.output_tokens, fingerprint, row.event_id);
        legacy.run(event.output_tokens, row.event_id);
        observations.run(fingerprint, row.event_id, row.semantic_fingerprint);
      }
      db.prepare(`UPDATE ingestion_state SET size_bytes = ?, mtime_ms = ?, file_identity = ?, committed_prefix_hash = ? WHERE stream_name = 'events.jsonl'`)
        .run(updatedStat.size, updatedStat.mtimeMs, identity.fileIdentity, identity.committedPrefixHash);
    })();
    swapped = false;
    Object.assign(report, { applied: true, patchedLogRows, cursorChanges, eventLogBytes: updatedStat.size });
    await writeFile(join(backupDir, "output-token-repair-report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    if (swapped) {
      await rename(logPath, join(backupDir, `events.failed-repair-${process.pid}.jsonl`));
      await rename(originalLog, logPath);
      await copyFile(originalCursor, cursorPath);
    }
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(value => {
    const [key, ...rest] = value.replace(/^--/u, "").split("="); return [key, rest.join("=") || true];
  }));
  if (typeof args["data-root"] !== "string") throw new Error("--data-root=/absolute/path is required");
  const report = await repairCodexOutputHistory({
    dataRoot: args["data-root"], apply: args.apply === true,
    backupDir: args["backup-dir"], since: args.since,
    onProgress: data => console.log(JSON.stringify({ phase: "scan", ...data }))
  });
  console.log(JSON.stringify(report, null, 2));
}
