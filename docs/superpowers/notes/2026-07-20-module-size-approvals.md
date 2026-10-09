# Phase 3 module size approvals (2026-07-20)

Spec: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md` Phase 3 exit criteria.

## Policy

Phase 3 requires that no replacement production module exceed **600 non-generated lines** without documented reviewer approval.

## Core modules under limit (no split required)

| Module | Lines (approx.) | Status |
|---|---:|---|
| `apps/core/src/event-log-projector.ts` | 543 | Under limit; byte-range ingest, legacy persistence, projection watermark |
| `apps/core/src/sync-coordinator.ts` | 515 | Under limit; FIFO/concurrency/coalescing and shutdown |
| `apps/core/src/raw-ingest.ts` | 469 | Under limit; spool/lease/byte cursor primitives |
| `apps/core/src/domain-backfill.ts` | 418 | Under limit |
| `apps/core/src/session-queries.ts` | 409 | Under limit |
| `apps/core/src/domain-projection.ts` | 406 | Under limit |

## Temporarily approved modules above 600 lines

| Path | Lines (approx.) | Owner phase | Temporary approval reason |
|---|---:|---|---|
| `packages/adapters-cursor/src/cursor-sync.ts` | 1225 | Phase 2/4 adapters | Cursor IDE artifact sync is a single high-branching adapter surface; splitting risks diverging ledger/cursor semantics before adapter-instance wrapper migration is complete. |
| `packages/adapters-codex/src/codex.ts` | 905 | Phase 2/4 adapters | Codex rollout + logs reconciliation shares one normalization pipeline; extraction deferred until sync-coordinator adapter wrappers stabilize. |
| `packages/adapters-claude/src/transcript-sync.ts` | 605 | Phase 2/4 adapters | Just above threshold; transcript ledger + manifest replay move behind `claude-transcript@*` adapter instance wrapper in Phase 4 follow-up. |
| `apps/desktop/src/main.ts` | 999 | Phase 7 | Legacy orb/floating/peek entry kept only until Phase 7 parity evidence is complete; production entry is `main-v2.ts` (~537 lines). |
| `apps/dashboard/src/LegacyDesktopSurfaces.tsx` | 301 | Phase 7 | Isolated legacy orb/peek/floating surfaces; Main dashboard is the thin `App.tsx` SurfaceRouter (~28 lines) + `DashboardPage`. |

Reviewer approval is recorded here for Phase 3 gap closure only. Each over-limit module still needs a tracked split before its owning phase declares complete.

## Dead code cleanup

`request-sync.ts` was removed in this gap pass. Coalescing now lives in `event-log-projector.createEventLogSynchronizer` and `SyncCoordinator`; there is no standalone request-sync helper in production.
