declare module "better-sqlite3" {
  interface Statement<Result = unknown> {
    all(...params: unknown[]): Result[];
    get(...params: unknown[]): Result | undefined;
    run(...params: unknown[]): unknown;
  }

  interface Database {
    close(): this;
    exec(sql: string): this;
    prepare<Result = unknown>(sql: string): Statement<Result>;
  }

  interface DatabaseConstructor {
    new (
      filename: string,
      options?: {
        readonly?: boolean;
        fileMustExist?: boolean;
      }
    ): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
