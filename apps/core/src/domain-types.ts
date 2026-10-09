export interface SqliteStatementLike<Row = unknown> {
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | undefined;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare<Row = unknown>(sql: string): SqliteStatementLike<Row>;
  transaction<T>(operation: () => T): () => T;
}

export class DomainMigrationError extends Error {
  readonly code: string;
  readonly diagnostic: Record<string, unknown>;

  constructor(code: string, message: string, diagnostic: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "DomainMigrationError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export type MigrationNow = Date | string | (() => Date | string);
export type Row = Record<string, unknown>;
