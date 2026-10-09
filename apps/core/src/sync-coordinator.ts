import type {
  ManualSyncResponse,
  SyncAdapter,
  SyncAdapterState,
  SyncCoordinatorOptions,
  SyncError,
  SyncResult,
  SyncRun,
  SyncRunPersistence,
  SyncStatusSnapshot,
  SyncTriggerResult
} from "./sync-types.js";
import {
  DEFAULT_FRESHNESS_MS,
  DEFAULT_PERIODIC_SYNC_MS,
  DEFAULT_RUN_RETENTION_MS,
  DEFAULT_SYNC_RUN_TIMEOUT_MS,
  SyncCoordinatorError,
  cloneRun,
  cloneState,
  normalizeConcurrency,
  normalizeDuration,
  normalizeId,
  normalizeResult,
  restoreState,
  snapshotState,
  toSyncError,
  validateAdapter,
  type StateSnapshot
} from "./sync-utils.js";

export type {
  ManualSyncResponse,
  SyncAdapter,
  SyncAdapterState,
  SyncCoordinatorOptions,
  SyncError,
  SyncResult,
  SyncRun,
  SyncRunPersistence,
  SyncStatusSnapshot,
  SyncTriggerResult
} from "./sync-types.js";
export { SyncCoordinatorError } from "./sync-utils.js";

type InternalRun = {
  run: SyncRun;
  adapter: SyncAdapter;
  controller: AbortController;
  restoreState: StateSnapshot;
};

let defaultRunSequence = 0;
let defaultRequestSequence = 0;

export class SyncCoordinator {
  private readonly adapters = new Map<string, SyncAdapter>();
  private readonly states = new Map<string, SyncAdapterState>();
  private readonly runs = new Map<string, InternalRun>();
  private readonly queuedRunIds: string[] = [];
  private readonly activeRunIds = new Set<string>();
  private readonly concurrency: number;
  private readonly freshnessMs: number;
  private readonly runRetentionMs: number;
  private readonly periodicIntervalMs: number;
  private readonly nowFactory: NonNullable<SyncCoordinatorOptions["now"]>;
  private readonly runIdFactory: NonNullable<SyncCoordinatorOptions["runId"]>;
  private readonly requestIdFactory: NonNullable<SyncCoordinatorOptions["requestId"]>;
  private readonly persistence: SyncRunPersistence | null;
  private readonly persistedRuns = new Map<string, SyncRun>();
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(adapters: readonly SyncAdapter[], options?: SyncCoordinatorOptions);
  constructor(options?: SyncCoordinatorOptions);
  constructor(
    adaptersOrOptions: readonly SyncAdapter[] | SyncCoordinatorOptions = [],
    options: SyncCoordinatorOptions = {}
  ) {
    const config: SyncCoordinatorOptions = Array.isArray(adaptersOrOptions)
      ? { ...options, adapters: adaptersOrOptions as readonly SyncAdapter[] }
      : adaptersOrOptions as SyncCoordinatorOptions;

    this.concurrency = normalizeConcurrency(config.maxConcurrency);
    this.freshnessMs = normalizeDuration(config.freshnessMs, DEFAULT_FRESHNESS_MS);
    this.runRetentionMs = normalizeDuration(config.runRetentionMs, DEFAULT_RUN_RETENTION_MS);
    this.periodicIntervalMs = normalizeDuration(config.periodicIntervalMs, DEFAULT_PERIODIC_SYNC_MS);
    this.nowFactory = config.now ?? (() => new Date());
    this.runIdFactory = config.runId ?? (() => `sync-run-${++defaultRunSequence}`);
    this.requestIdFactory = config.requestId ?? (() => `sync-request-${++defaultRequestSequence}`);
    this.persistence = config.persistence ?? null;

    if (this.persistence !== null) {
      for (const run of this.persistence.load(this.readNowMs(), this.runRetentionMs)) {
        this.persistedRuns.set(run.runId, cloneRun(run));
      }
    }

    // Default IDs restart at 1 per process; advance past any persisted sync-run-N ids.
    if (config.runId === undefined) {
      for (const runId of this.persistedRuns.keys()) {
        const match = /^sync-run-(\d+)$/u.exec(runId);
        if (match !== null) {
          defaultRunSequence = Math.max(defaultRunSequence, Number(match[1]));
        }
      }
    }

    for (const adapter of config.adapters ?? []) {
      this.register(adapter);
    }
  }

  register(adapter: SyncAdapter): SyncAdapterState {
    validateAdapter(adapter);
    if (this.adapters.has(adapter.adapterInstanceId)) {
      throw new SyncCoordinatorError(
        "ADAPTER_ALREADY_REGISTERED",
        `Adapter ${adapter.adapterInstanceId} is already registered`
      );
    }

    const copy = { ...adapter };
    this.adapters.set(copy.adapterInstanceId, copy);
    const state: SyncAdapterState = {
      adapterInstanceId: copy.adapterInstanceId,
      sourceInstanceId: copy.sourceInstanceId,
      sourceAdapter: copy.sourceAdapter,
      sourceVendor: copy.sourceVendor,
      status: copy.enabled ? "idle" : "disabled",
      activeRunId: null,
      pendingRunId: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastSuccessfulAt: null,
      nextScheduledAt: null,
      lastError: null,
      consecutiveFailures: 0
    };
    this.states.set(copy.adapterInstanceId, state);
    return cloneState(state);
  }

  registerAdapter(adapter: SyncAdapter): SyncAdapterState {
    return this.register(adapter);
  }

  setEnabled(adapterInstanceId: string, enabled: boolean): SyncAdapterState {
    const adapter = this.getAdapterOrThrow(adapterInstanceId);
    const state = this.getStateOrThrow(adapterInstanceId);

    if (!enabled && (state.activeRunId !== null || state.pendingRunId !== null)) {
      throw new SyncCoordinatorError("ADAPTER_BUSY", `Adapter ${adapterInstanceId} has an accepted run`);
    }

    adapter.enabled = enabled;
    if (!enabled) {
      state.status = "disabled";
    } else {
      state.status = state.lastSuccessfulAt === null
        ? "idle"
        : this.isFresh(state.lastSuccessfulAt, this.readNowMs())
          ? "ready"
          : "stale";
    }
    return cloneState(state);
  }

  trigger(adapterInstanceId: string): SyncTriggerResult {
    return this.accept(adapterInstanceId, this.readNowIso());
  }

  requestSync(adapterInstanceId: string): SyncTriggerResult {
    return this.trigger(adapterInstanceId);
  }

  triggerSync(adapterInstanceId: string): SyncTriggerResult {
    return this.trigger(adapterInstanceId);
  }

  manualSync(adapterInstanceId?: string): ManualSyncResponse {
    const adapterIds = adapterInstanceId === undefined
      ? [...this.adapters.keys()].filter((id) => this.getStateOrThrow(id).status !== "disabled")
      : [adapterInstanceId];
    return this.acceptAdapters(adapterIds);
  }

  triggerAll(): ManualSyncResponse {
    return this.manualSync();
  }

  startInitialSync(adapterInstanceIds?: readonly string[]): ManualSyncResponse {
    const adapterIds = (adapterInstanceIds ?? [...this.adapters.keys()]).filter(
      (id) => this.getStateOrThrow(id).status !== "disabled"
    );
    return this.acceptAdapters(adapterIds);
  }

  startPeriodicSync(
    intervalMs = this.periodicIntervalMs,
    adapterInstanceIds?: readonly string[]
  ): void {
    this.assertOpen();
    if (this.periodicTimer !== null) {
      return;
    }
    const interval = normalizeDuration(intervalMs, this.periodicIntervalMs);
    if (interval <= 0) {
      return;
    }
    const targetAdapterIds = adapterInstanceIds === undefined
      ? null
      : new Set(adapterInstanceIds);
    if (targetAdapterIds !== null) {
      for (const adapterInstanceId of targetAdapterIds) {
        this.getStateOrThrow(adapterInstanceId);
      }
    }
    const scheduleNext = () => {
      const nextScheduledAt = new Date(this.readNowMs() + interval).toISOString();
      for (const state of this.states.values()) {
        if (
          state.status !== "disabled" &&
          (targetAdapterIds === null || targetAdapterIds.has(state.adapterInstanceId))
        ) {
          state.nextScheduledAt = nextScheduledAt;
        }
      }
    };
    scheduleNext();
    this.periodicTimer = setInterval(() => {
      if (this.shuttingDown) {
        return;
      }
      try {
        if (targetAdapterIds === null) {
          this.triggerAll();
        } else {
          this.startInitialSync([...targetAdapterIds]);
        }
      } catch {
        // The next tick remains the recovery point; adapter errors are recorded by runs.
      }
      scheduleNext();
    }, interval);
  }

  stopPeriodicSync(): void {
    if (this.periodicTimer === null) {
      return;
    }
    clearInterval(this.periodicTimer);
    this.periodicTimer = null;
    for (const state of this.states.values()) {
      state.nextScheduledAt = null;
    }
  }

  getStatus(): SyncStatusSnapshot;
  getStatus(adapterInstanceId: string): SyncAdapterState | null;
  getStatus(adapterInstanceId?: string): SyncStatusSnapshot | SyncAdapterState | null {
    const now = this.readNow();
    this.refreshFreshness(now.getTime());
    this.pruneRuns(now.getTime());

    if (adapterInstanceId !== undefined) {
      const state = this.states.get(adapterInstanceId);
      return state ? cloneState(state) : null;
    }

    return {
      generatedAt: now.toISOString(),
      shuttingDown: this.shuttingDown,
      adapters: [...this.states.values()].map(cloneState)
    };
  }

  /** True when any adapter run is queued or actively syncing. */
  hasActiveWork(): boolean {
    for (const state of this.states.values()) {
      if (state.activeRunId !== null || state.pendingRunId !== null) {
        return true;
      }
    }
    return this.activeRunIds.size > 0 || this.queuedRunIds.length > 0;
  }

  /**
   * Record a background/light-refresh success without creating a SyncRun.
   * Skips adapters that currently have an accepted coordinator run.
   */
  markBackgroundSuccess(adapterInstanceId: string): SyncAdapterState | null {
    const state = this.states.get(adapterInstanceId);
    if (!state) {
      return null;
    }
    if (state.activeRunId !== null || state.pendingRunId !== null || state.status === "syncing") {
      return cloneState(state);
    }
    if (state.status === "disabled") {
      return cloneState(state);
    }

    const completedAt = this.readNowIso();
    state.status = "ready";
    state.lastCompletedAt = completedAt;
    state.lastSuccessfulAt = completedAt;
    state.lastError = null;
    state.consecutiveFailures = 0;
    return cloneState(state);
  }

  getAdapterStates(): SyncAdapterState[] {
    const status = this.getStatus();
    return status.adapters;
  }

  getRun(runId: string): SyncRun | null {
    const now = this.readNowMs();
    this.pruneRuns(now);
    const internal = this.runs.get(runId);
    if (internal) {
      return cloneRun(internal.run);
    }
    const persisted = this.persistedRuns.get(runId);
    return persisted ? cloneRun(persisted) : null;
  }

  getRuns(): SyncRun[] {
    const now = this.readNowMs();
    this.pruneRuns(now);
    return [
      ...Array.from(this.runs.values(), (internal) => cloneRun(internal.run)),
      ...Array.from(this.persistedRuns.values(), cloneRun)
    ];
  }

  shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return Promise.resolve();
    }

    this.shuttingDown = true;
    this.stopPeriodicSync();
    const completedAt = this.readNowIso();
    const acceptedRunIds = [...this.queuedRunIds, ...this.activeRunIds];
    this.queuedRunIds.length = 0;

    for (const runId of acceptedRunIds) {
      const internal = this.runs.get(runId);
      if (!internal) {
        continue;
      }
      this.abortRun(internal, completedAt);
      internal.controller.abort();
    }

    this.activeRunIds.clear();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.shutdown();
  }

  private accept(adapterInstanceId: string, acceptedAt: string): SyncTriggerResult {
    this.assertOpen();
    const adapter = this.getAdapterOrThrow(adapterInstanceId);
    const state = this.getStateOrThrow(adapterInstanceId);
    this.refreshFreshness(Date.parse(acceptedAt));

    if (!adapter.enabled || state.status === "disabled") {
      throw new SyncCoordinatorError("ADAPTER_DISABLED", `Adapter ${adapterInstanceId} is disabled`);
    }

    if (state.activeRunId !== null) {
      return {
        adapterInstanceId,
        runId: state.activeRunId,
        disposition: "coalesced"
      };
    }
    if (state.pendingRunId !== null) {
      return {
        adapterInstanceId,
        runId: state.pendingRunId,
        disposition: "coalesced"
      };
    }

    const runId = normalizeId(this.runIdFactory({ adapterInstanceId, acceptedAt }), "runId");
    if (this.runs.has(runId) || this.persistedRuns.has(runId)) {
      throw new SyncCoordinatorError("RUN_ID_COLLISION", `Run ${runId} already exists`);
    }

    const run: SyncRun = {
      runId,
      adapterInstanceId,
      status: "queued",
      acceptedAt,
      startedAt: null,
      completedAt: null,
      discoveredRecords: 0,
      committedUniqueEvents: 0,
      projectedUniqueEvents: 0,
      projectionWatermark: null,
      error: null
    };
    const internal: InternalRun = {
      run,
      adapter,
      controller: new AbortController(),
      restoreState: snapshotState(state)
    };
    this.runs.set(runId, internal);
    this.persistRun(run);

    if (this.activeRunIds.size < this.concurrency) {
      this.startRun(internal);
      return { adapterInstanceId, runId, disposition: "started" };
    }

    this.queuedRunIds.push(runId);
    state.pendingRunId = runId;
    state.status = "queued";
    return { adapterInstanceId, runId, disposition: "queued" };
  }

  private acceptAdapters(adapterInstanceIds: readonly string[]): ManualSyncResponse {
    this.assertOpen();
    const acceptedAt = this.readNowIso();
    const requestId = normalizeId(this.requestIdFactory(), "requestId");
    return {
      requestId,
      acceptedAt,
      runs: adapterInstanceIds.map((adapterInstanceId) => this.accept(adapterInstanceId, acceptedAt))
    };
  }

  private startRun(internal: InternalRun): void {
    const { run, adapter, controller } = internal;
    if (run.status !== "queued" || this.shuttingDown) {
      return;
    }

    const state = this.getStateOrThrow(run.adapterInstanceId);
    const startedAt = this.readNowIso();
    run.status = "syncing";
    run.startedAt = startedAt;
    state.status = "syncing";
    state.activeRunId = run.runId;
    state.pendingRunId = null;
    state.lastStartedAt = startedAt;
    this.activeRunIds.add(run.runId);
    this.persistRun(run);

    void this.execute(internal, adapter, controller);
  }

  private async execute(
    internal: InternalRun,
    adapter: SyncAdapter,
    controller: AbortController
  ): Promise<void> {
    const { run } = internal;
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }, DEFAULT_SYNC_RUN_TIMEOUT_MS);
    try {
      const syncResult = await adapter.sync({ runId: run.runId, signal: controller.signal });
      if (this.shuttingDown || controller.signal.aborted || run.status === "aborted") {
        if (controller.signal.aborted && !this.shuttingDown && run.status === "syncing") {
          this.completeFailure(internal, {
            code: "SYNC_TIMEOUT",
            summary: `Sync exceeded ${Math.round(DEFAULT_SYNC_RUN_TIMEOUT_MS / 60_000)} minutes and was aborted`
          });
        }
        return;
      }
      const normalizedResult = normalizeResult(syncResult);
      this.completeSuccess(internal, normalizedResult);
    } catch (error) {
      if (this.shuttingDown || controller.signal.aborted || run.status === "aborted") {
        if (controller.signal.aborted && !this.shuttingDown && run.status === "syncing") {
          this.completeFailure(internal, {
            code: "SYNC_TIMEOUT",
            summary: `Sync exceeded ${Math.round(DEFAULT_SYNC_RUN_TIMEOUT_MS / 60_000)} minutes and was aborted`
          });
        }
        return;
      }
      this.completeFailure(internal, toSyncError(error));
    } finally {
      clearTimeout(timeout);
      this.activeRunIds.delete(run.runId);
      if (!this.shuttingDown) {
        this.drainQueue();
      }
    }
  }

  private completeSuccess(internal: InternalRun, syncResult: SyncResult): void {
    const { run } = internal;
    if (run.status !== "syncing") {
      return;
    }

    const completedAt = this.readNowIso();
    Object.assign(run, syncResult, {
      status: "succeeded" as const,
      completedAt,
      error: null
    });
    this.persistRun(run);

    const state = this.getStateOrThrow(run.adapterInstanceId);
    state.status = "ready";
    state.activeRunId = null;
    state.pendingRunId = null;
    state.lastCompletedAt = completedAt;
    state.lastSuccessfulAt = completedAt;
    state.lastError = null;
    state.consecutiveFailures = 0;
  }

  private completeFailure(internal: InternalRun, error: SyncError): void {
    const { run } = internal;
    if (run.status !== "syncing") {
      return;
    }

    const completedAt = this.readNowIso();
    run.status = "failed";
    run.completedAt = completedAt;
    run.error = error;
    this.persistRun(run);

    const state = this.getStateOrThrow(run.adapterInstanceId);
    state.status = internal.restoreState.lastSuccessfulAt === null ? "error" : "stale";
    state.activeRunId = null;
    state.pendingRunId = null;
    state.lastCompletedAt = completedAt;
    state.lastError = error;
    state.consecutiveFailures += 1;
  }

  private abortRun(internal: InternalRun, completedAt: string): void {
    const { run } = internal;
    if (run.status === "succeeded" || run.status === "failed" || run.status === "aborted") {
      return;
    }

    run.status = "aborted";
    run.completedAt = completedAt;
    run.error = null;
    this.persistRun(run);
    restoreState(this.getStateOrThrow(run.adapterInstanceId), internal.restoreState);
  }

  private drainQueue(): void {
    while (!this.shuttingDown && this.activeRunIds.size < this.concurrency && this.queuedRunIds.length > 0) {
      const runId = this.queuedRunIds.shift();
      if (runId === undefined) {
        return;
      }
      const internal = this.runs.get(runId);
      if (!internal || internal.run.status !== "queued") {
        continue;
      }
      this.startRun(internal);
    }
  }

  private refreshFreshness(nowMs: number): void {
    for (const state of this.states.values()) {
      if (state.status === "ready" && state.lastSuccessfulAt !== null && !this.isFresh(state.lastSuccessfulAt, nowMs)) {
        state.status = "stale";
      }
    }
  }

  private isFresh(lastSuccessfulAt: string, nowMs: number): boolean {
    const successMs = Date.parse(lastSuccessfulAt);
    return Number.isFinite(successMs) && nowMs - successMs < this.freshnessMs;
  }

  private pruneRuns(nowMs: number): void {
    for (const [runId, internal] of this.runs) {
      const completedMs = internal.run.completedAt === null ? null : Date.parse(internal.run.completedAt);
      if (completedMs !== null && Number.isFinite(completedMs) && nowMs - completedMs >= this.runRetentionMs) {
        this.runs.delete(runId);
        this.persistence?.remove(runId);
      }
    }
    for (const [runId, run] of this.persistedRuns) {
      const completedMs = run.completedAt === null ? null : Date.parse(run.completedAt);
      if (completedMs !== null && Number.isFinite(completedMs) && nowMs - completedMs >= this.runRetentionMs) {
        this.persistedRuns.delete(runId);
        this.persistence?.remove(runId);
      }
    }
  }

  private getAdapterOrThrow(adapterInstanceId: string): SyncAdapter {
    const adapter = this.adapters.get(adapterInstanceId);
    if (!adapter) {
      throw new SyncCoordinatorError("ADAPTER_NOT_FOUND", `Adapter ${adapterInstanceId} was not registered`);
    }
    return adapter;
  }

  private getStateOrThrow(adapterInstanceId: string): SyncAdapterState {
    const state = this.states.get(adapterInstanceId);
    if (!state) {
      throw new SyncCoordinatorError("ADAPTER_NOT_FOUND", `Adapter ${adapterInstanceId} was not registered`);
    }
    return state;
  }

  private assertOpen(): void {
    if (this.shuttingDown) {
      throw new SyncCoordinatorError("SYNC_SHUTTING_DOWN", "Sync coordinator is shutting down");
    }
  }

  private readNow(): Date {
    const value = this.nowFactory();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new SyncCoordinatorError("INVALID_CLOCK", "The coordinator clock returned an invalid time");
    }
    return date;
  }

  private readNowIso(): string {
    return this.readNow().toISOString();
  }

  private readNowMs(): number {
    return this.readNow().getTime();
  }

  private persistRun(run: SyncRun): void {
    const snapshot = cloneRun(run);
    this.persistence?.save(snapshot);
    if (this.runs.has(run.runId)) {
      return;
    }
    this.persistedRuns.set(run.runId, snapshot);
  }
}

export function createSyncCoordinator(
  adapters: readonly SyncAdapter[],
  options?: SyncCoordinatorOptions
): SyncCoordinator;
export function createSyncCoordinator(options?: SyncCoordinatorOptions): SyncCoordinator;
export function createSyncCoordinator(
  adaptersOrOptions: readonly SyncAdapter[] | SyncCoordinatorOptions = [],
  options: SyncCoordinatorOptions = {}
): SyncCoordinator {
  if (Array.isArray(adaptersOrOptions)) {
    return new SyncCoordinator(adaptersOrOptions as readonly SyncAdapter[], options);
  }
  return new SyncCoordinator(adaptersOrOptions as SyncCoordinatorOptions);
}
