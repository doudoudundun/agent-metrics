import type { SourceVendor } from "@agent-metrics/event-schema";

export type MetricsStatement<Result = unknown> = {
  all(...params: unknown[]): Result[];
  get(...params: unknown[]): Result;
  run(...params: unknown[]): unknown;
};

export type MetricsDatabase = {
  close(): void;
  exec(sql: string): unknown;
  pragma(pragma: string): unknown;
  prepare<Result = unknown>(sql: string): MetricsStatement<Result>;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult;
};

export type SourceVendorFilter = SourceVendor | "all";

export type BuildAppInput = {
  dbPath: string;
  eventLogPath?: string;
  repoRoot?: string;
  now?: () => Date;
  timezone?: string;
  offsetMinutes?: number;
  trustedOrigins?: readonly string[];
  localAccessToken?: string;
};
