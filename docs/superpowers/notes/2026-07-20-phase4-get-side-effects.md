# Phase 4 GET side effects and §21 performance (2026-07-20)

Spec: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md` §12.4, Phase 4 exit criteria, and §21.

## Structural guarantee

After Phase 4, Core read routes are registered in `apps/core/src/core-routes.ts` and `apps/core/src/legacy-routes.ts` as **pure database projections**:

- GET handlers call query helpers (`selectWidgetSnapshot`, `selectOverviewRows`, `selectSessions`, etc.) or read-only coordinator accessors (`getStatus`, `getRun`).
- Adapter synchronization, canonical writer leases, event-log projection, and ingestion cursor advancement are owned by `SyncCoordinator` startup/periodic/manual paths and by `onReady` background projection — not by GET hooks.
- `buildApp` no longer attaches per-request `preHandler` sync hooks to aggregate routes.

This is the structural basis for the §21 requirement that **committed aggregate GET requests do not await source synchronization**. GET latency is bounded by SQLite reads on already-projected state, not by adapter discovery or JSONL append work.

## Automated evidence

| Requirement | Test location |
|---|---|
| GET routes do not invoke adapters | `apps/core/src/get-routes-side-effects.test.ts` |
| GET routes do not invoke projection ingest | `apps/core/src/get-routes-side-effects.test.ts` (`ingestEventLog` spy) |
| GET routes do not mutate coordinator state | `apps/core/src/get-routes-side-effects.test.ts` (`trigger` / `manualSync` spies) |
| Concurrent GET does not re-sync adapters | `apps/core/src/app.test.ts` ("does not synchronize adapters from concurrent GET requests") |
| Coordinator coalescing / shutdown / watermark visibility | `apps/core/src/sync-coordinator.test.ts` |
| Durable run retention and freshness | `apps/core/src/sync-coordinator.test.ts`, `apps/core/src/sync-run-store.test.ts` |

## §21 performance follow-up (not satisfied by structure alone)

Section 21 still requires fixture-backed p95 measurements for aggregate endpoints and the blocked-adapter scenario (`committed aggregate GET remains below 500 ms while one adapter fixture is blocked in discovery`). The structural separation above is necessary but **not sufficient** for §21 sign-off; record machine class, warm-up, and sample count when those benchmarks are run.

## Phase 4 residual checklist

- [x] GET route side-effect spies
- [x] Coordinator coalescing, shutdown-abort, watermark, freshness, retention tests
- [x] Structural GET-does-not-await-sync note (this document)
- [ ] §21 blocked-adapter aggregate GET benchmark (deferred to performance fixture work)
