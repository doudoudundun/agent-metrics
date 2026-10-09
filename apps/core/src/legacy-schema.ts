export type LegacyDatabase = {
  exec(sql: string): unknown;
  prepare<Row = unknown>(sql: string): {
    all(...params: unknown[]): Row[];
  };
};

export function initializeLegacySchema(db: LegacyDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      prompt_chars INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_responses (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      model TEXT,
      stop_reason TEXT,
      response_chars INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      provider_id TEXT,
      provider_base_url TEXT,
      provider_host TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      server_tool_use TEXT NOT NULL DEFAULT '{}',
      usage_source TEXT NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      provider_id TEXT,
      provider_base_url TEXT,
      provider_host TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_edits (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      files_changed TEXT NOT NULL DEFAULT '[]',
      file_count INTEGER NOT NULL,
      insertions INTEGER NOT NULL,
      deletions INTEGER NOT NULL,
      edit_operation_count INTEGER NOT NULL,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingestion_state (
      stream_name TEXT PRIMARY KEY,
      offset_bytes INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      file_identity TEXT,
      committed_prefix_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS session_contexts (
      session_id TEXT PRIMARY KEY,
      source_vendor TEXT NOT NULL,
      source_adapter TEXT NOT NULL,
      execution_path TEXT,
      skills_loaded INTEGER NOT NULL DEFAULT 0,
      skill_names_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );

  `);
  migrateIngestionStateSchema(db);
  migrateLegacySessionsSchema(db);
  migrateLegacyCodeEditsSchema(db);
  migrateLegacyEventTableSchema(db, "tool_events", { defaultAdapter: "claude-hook" });
  migrateLegacyToolEventsSchema(db);
  migrateLegacyEventTableSchema(db, "prompt_events", { defaultAdapter: "claude-transcript" });
  migrateLegacyEventTableSchema(db, "assistant_responses", {
    defaultAdapter: "claude-transcript",
    includeProviderColumns: true
  });
  migrateLegacyEventTableSchema(db, "token_usage_events", {
    defaultAdapter: "claude-transcript",
    includeProviderColumns: true
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_source_started_at
      ON sessions (source_vendor, started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_events_source_created_at
      ON tool_events (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_prompt_events_source_created_at
      ON prompt_events (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_assistant_responses_source_created_at
      ON assistant_responses (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_source_created_at
      ON token_usage_events (source_vendor, created_at);
    CREATE INDEX IF NOT EXISTS idx_code_edits_source_created_at
      ON code_edits (source_vendor, created_at);
  `);
}

function migrateIngestionStateSchema(db: LegacyDatabase): void {
  const columns = db.prepare<{ name: string }>("PRAGMA table_info(ingestion_state)").all();
  if (!columns.some((column) => column.name === "file_identity")) {
    db.exec("ALTER TABLE ingestion_state ADD COLUMN file_identity TEXT");
  }
  if (!columns.some((column) => column.name === "committed_prefix_hash")) {
    db.exec("ALTER TABLE ingestion_state ADD COLUMN committed_prefix_hash TEXT");
  }
}

function migrateLegacySessionsSchema(db: LegacyDatabase): void {
  const columns = db.prepare<{ name: string }>("PRAGMA table_info(sessions)").all();
  if (!columns.some((column) => column.name === "ended_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
  }
  if (!columns.some((column) => column.name === "exit_code")) {
    db.exec("ALTER TABLE sessions ADD COLUMN exit_code INTEGER");
  }
  if (!columns.some((column) => column.name === "source_vendor")) {
    db.exec("ALTER TABLE sessions ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code'");
  }
  if (!columns.some((column) => column.name === "source_adapter")) {
    db.exec("ALTER TABLE sessions ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'claude-hook'");
  }
}

function migrateLegacyCodeEditsSchema(db: LegacyDatabase): void {
  const columns = db.prepare<{ name: string }>("PRAGMA table_info(code_edits)").all();
  if (columns.length === 0) {
    return;
  }
  if (!columns.some((column) => column.name === "files_changed")) {
    db.exec("ALTER TABLE code_edits ADD COLUMN files_changed TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.some((column) => column.name === "source_vendor")) {
    db.exec("ALTER TABLE code_edits ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code'");
  }
  if (!columns.some((column) => column.name === "source_adapter")) {
    db.exec("ALTER TABLE code_edits ADD COLUMN source_adapter TEXT NOT NULL DEFAULT 'claude-hook'");
  }
}

function migrateLegacyEventTableSchema(
  db: LegacyDatabase,
  tableName: "tool_events" | "prompt_events" | "assistant_responses" | "token_usage_events",
  input: { defaultAdapter: "claude-hook" | "claude-transcript"; includeProviderColumns?: boolean }
): void {
  const columns = db.prepare<{ name: string }>(`PRAGMA table_info(${tableName})`).all();
  if (columns.length === 0) {
    return;
  }
  if (!columns.some((column) => column.name === "source_vendor")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN source_vendor TEXT NOT NULL DEFAULT 'claude-code'`);
  }
  if (!columns.some((column) => column.name === "source_adapter")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN source_adapter TEXT NOT NULL DEFAULT '${input.defaultAdapter}'`);
  }
  if (!input.includeProviderColumns) {
    return;
  }
  if (!columns.some((column) => column.name === "provider_id")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN provider_id TEXT`);
  }
  if (!columns.some((column) => column.name === "provider_base_url")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN provider_base_url TEXT`);
  }
  if (!columns.some((column) => column.name === "provider_host")) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN provider_host TEXT`);
  }
}

function migrateLegacyToolEventsSchema(db: LegacyDatabase): void {
  const columns = db.prepare<{ name: string }>("PRAGMA table_info(tool_events)").all();
  if (columns.length === 0) {
    return;
  }
  if (!columns.some((column) => column.name === "tool_call_id")) {
    db.exec("ALTER TABLE tool_events ADD COLUMN tool_call_id TEXT");
  }
}
