import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeWorkspacePath } from "@agent-metrics/event-schema";

/**
 * Reads `conversation_id -> workspace_path` mappings from Antigravity's
 * `conversation_summaries.db`. Returns an empty map when the database is absent,
 * locked, or unreadable so workspace metadata gaps never block usage ingestion.
 */
export function readAntigravityConversationWorkspaces(dbPath: string): Map<string, string> {
  const workspaces = new Map<string, string>();
  if (!existsSync(dbPath)) {
    return workspaces;
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
    const rows = db
      .prepare<{ conversation_id: string; workspace_uris: string }>(
        "SELECT conversation_id, workspace_uris FROM conversation_summaries"
      )
      .all();
    for (const row of rows) {
      if (typeof row.conversation_id !== "string" || typeof row.workspace_uris !== "string") {
        continue;
      }
      try {
        const uris: unknown = JSON.parse(row.workspace_uris);
        if (!Array.isArray(uris)) {
          continue;
        }
        const uri = uris.find((value): value is string => typeof value === "string" && value.startsWith("file:"));
        if (!uri) {
          continue;
        }
        workspaces.set(row.conversation_id, normalizeWorkspacePath(fileURLToPath(uri)));
      } catch {
        // Missing or unsupported workspace metadata does not prevent counting usage.
      }
    }
  } catch {
    // Unreadable summary DBs must not fail transcript ingestion.
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors on failed or already-closed handles.
    }
  }
  return workspaces;
}
