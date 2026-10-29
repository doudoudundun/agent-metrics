#!/usr/bin/env node
/**
 * Remove WorkBuddy rows that WorkBuddy Switch duplicated by cloning a
 * transcript under a new session id.
 *
 *   node scripts/purge-workbuddy-clone-duplicates.mjs --db <metrics.sqlite> [options]
 *
 * Options:
 *   --apply                  Perform the deletion (default is a dry run)
 *   --backup-dir <dir>       Where to write the pre-change backup (default: D:/backups/agent-metrics)
 *   --ledger <path>          workbuddy-ledger.json; rewritten to session-less keys so cloned
 *                            records stay deduplicated after the cleanup
 *
 * A session is treated as a clone when every one of its usage message ids also
 * appears in another session (and that other session keeps more, or the same
 * amount with an earlier first usage). The clone's rows are then dropped from
 * both the canonical and the legacy tables, so dashboards no longer count the
 * same conversation twice.
 */

import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCore = createRequire(join(repoRoot, "apps/core/package.json"));
const Database = requireFromCore("better-sqlite3");

const VENDOR = "workbuddy";

function parseArgs(argv) {
  const options = { apply: false, db: null, backupDir: "D:/backups/agent-metrics", ledger: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--db") options.db = argv[++index];
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else if (arg === "--ledger") options.ledger = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/purge-workbuddy-clone-duplicates.mjs --db <metrics.sqlite> [--apply] [--backup-dir <dir>] [--ledger <path>]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.db) throw new Error("--db is required");
  return options;
}

function sessionStats(db) {
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId,
              COUNT(*) AS rowCount,
              MIN(occurred_at) AS firstAt,
              SUM(raw_input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens
         FROM usage_events
        WHERE source_vendor = ?
        GROUP BY session_id`
    )
    .all(VENDOR);
  const pairs = db
    .prepare(`SELECT session_id AS sessionId, message_id AS messageId FROM usage_events WHERE source_vendor = ?`)
    .all(VENDOR);

  const messageIds = new Map();
  for (const { sessionId, messageId } of pairs) {
    let set = messageIds.get(sessionId);
    if (!set) messageIds.set(sessionId, (set = new Set()));
    set.add(messageId);
  }
  return rows.map((row) => ({ ...row, messageIds: messageIds.get(row.sessionId) ?? new Set() }));
}

function isSubset(left, right) {
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function rank(a, b) {
  if (a.firstAt !== b.firstAt) return a.firstAt < b.firstAt ? -1 : 1;
  return a.sessionId.localeCompare(b.sessionId);
}

function findClones(sessions) {
  const clones = new Map();
  for (const candidate of sessions) {
    for (const other of sessions) {
      if (other === candidate) continue;
      if (!isSubset(candidate.messageIds, other.messageIds)) continue;
      const equal = candidate.messageIds.size === other.messageIds.size;
      if (!equal) {
        clones.set(candidate.sessionId, { row: candidate, keeper: other.sessionId });
        break;
      }
      if (rank(other, candidate) < 0) {
        clones.set(candidate.sessionId, { row: candidate, keeper: other.sessionId });
        break;
      }
    }
  }
  return clones;
}

function toolCallOverflow(db, cloneId, keeperId) {
  const rows = db
    .prepare(
      `SELECT tool_call_id AS id FROM tool_calls WHERE session_id = ?
       EXCEPT
       SELECT tool_call_id AS id FROM tool_calls WHERE session_id = ?`
    )
    .all(cloneId, keeperId);
  return rows.length;
}

function deleteStatements() {
  return [
    ["usage_events", "DELETE FROM usage_events WHERE source_vendor = ? AND session_id = ?"],
    ["token_usage_events", "DELETE FROM token_usage_events WHERE source_vendor = ? AND session_id = ?"],
    ["normalized_events", "DELETE FROM normalized_events WHERE source_vendor = ? AND session_id = ?"],
    ["assistant_responses", "DELETE FROM assistant_responses WHERE source_vendor = ? AND session_id = ?"],
    ["prompt_events", "DELETE FROM prompt_events WHERE source_vendor = ? AND session_id = ?"],
    ["tool_events", "DELETE FROM tool_events WHERE source_vendor = ? AND session_id = ?"],
    ["code_edits", "DELETE FROM code_edits WHERE source_vendor = ? AND session_id = ?"],
    ["tool_calls", "DELETE FROM tool_calls WHERE session_id = ? AND source_instance_id LIKE 'workbuddy%'"],
    ["domain_sessions", "DELETE FROM domain_sessions WHERE source_vendor = ? AND session_id = ?"],
    ["sessions", "DELETE FROM sessions WHERE source_vendor = ? AND session_id = ?"]
  ];
}

function stableLedgerKey(eventId) {
  const prefix = "workbuddy:";
  if (!eventId.startsWith(prefix)) return eventId;
  const hasTiming = eventId.endsWith(":timing-v1");
  const base = hasTiming ? eventId.slice(0, -":timing-v1".length) : eventId;
  const rest = base.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator === -1) return eventId;
  const suffix = rest.slice(separator + 1);
  // `session.started` has to stay per session: a cloned transcript without new
  // records must not create a second session.
  if (suffix === "started") return eventId;
  const stable = `${prefix}${suffix}`;
  return hasTiming ? `${stable}:timing-v1` : stable;
}

async function rewriteLedger(ledgerPath, apply) {
  const parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
  const eventIds = Array.isArray(parsed.eventIds) ? parsed.eventIds : [];
  const next = new Set();
  let remapped = 0;
  for (const eventId of eventIds) {
    const stable = stableLedgerKey(eventId);
    if (stable !== eventId) remapped += 1;
    next.add(stable);
  }
  console.log(`ledger: ${eventIds.length} keys -> ${next.size} keys (${remapped} remapped)`);
  if (!apply) return;
  await writeFile(ledgerPath, JSON.stringify({ eventIds: [...next].sort() }, null, 2), "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.db)) throw new Error(`database not found: ${options.db}`);

  const db = new Database(options.db, { readonly: !options.apply });
  db.pragma("busy_timeout = 10000");

  const sessions = sessionStats(db);
  const clones = findClones(sessions);
  console.log(`workbuddy sessions: ${sessions.length}, clones detected: ${clones.size}`);

  let removedRows = 0;
  let removedInput = 0;
  let removedOutput = 0;
  for (const [cloneId, { row, keeper }] of clones) {
    const overflow = toolCallOverflow(db, cloneId, keeper);
    console.log(
      `  clone ${cloneId} -> keep ${keeper}  rows=${row.rowCount} input=${row.inputTokens} output=${row.outputTokens}` +
        (overflow > 0 ? `  WARNING: ${overflow} tool calls not present in keeper` : "")
    );
    removedRows += row.rowCount;
    removedInput += row.inputTokens;
    removedOutput += row.outputTokens;
  }
  console.log(`rows to delete: ${removedRows}, input=${removedInput}, output=${removedOutput}`);

  if (!options.apply) {
    console.log("dry run: pass --apply to delete");
    db.close();
    return;
  }

  await mkdir(options.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(options.backupDir, `metrics-${stamp}.sqlite`);
  console.log(`backup -> ${backupPath}`);
  await db.backup(backupPath);

  const statements = deleteStatements();
  const run = db.transaction(() => {
    const totals = new Map();
    for (const [cloneId] of clones) {
      for (const [table, sql] of statements) {
        const params = sql.includes("source_instance_id") ? [cloneId] : [VENDOR, cloneId];
        const info = db.prepare(sql).run(...params);
        totals.set(table, (totals.get(table) ?? 0) + info.changes);
      }
    }
    return totals;
  });
  const totals = run();
  for (const [table, count] of totals) console.log(`  ${table}: -${count}`);

  if (options.ledger && existsSync(options.ledger)) {
    await rewriteLedger(options.ledger, true);
  }

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  console.log("done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
