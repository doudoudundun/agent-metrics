declare module "better-sqlite3" {
  interface Statement<Result = unknown> {
    all(...params: unknown[]): Result[];
    get(...params: unknown[]): Result;
    run(...params: unknown[]): unknown;
  }

  interface Database {
    close(): this;
    exec(sql: string): this;
    prepare<Result = unknown>(sql: string): Statement<Result>;
  }

  interface DatabaseConstructor {
    new (filename: string): Database;
  }

  const Database: DatabaseConstructor;

  namespace Database {
    export type Database = import("better-sqlite3").Database;
    export type Statement<Result = unknown> = import("better-sqlite3").Statement<Result>;
  }

  export default Database;
}
