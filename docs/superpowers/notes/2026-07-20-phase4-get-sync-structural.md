# Phase 4 GET latency structural note (2026-07-20)

Spec: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md` §21 / Phase 4 exit criteria.

## What is proven in-repo today

Deterministic tests now cover two layers:

1. **Structural isolation** — `apps/core/src/get-side-effects.test.ts` asserts every `app.get(...)` handler in `core-routes.ts` excludes sync/projector entrypoints (`manualSync`, `triggerAll`, `startInitialSync`, `startPeriodicSync`, `ingestEventLog`, `projectEventLog`, `syncEventLog`, `runWithCanonicalWriterLease`, `projectAfterSourceSync`).
2. **Runtime spies** — the same file spies on `SyncCoordinator` sync triggers and `ingestEventLog` while issuing GET `/api/overview`, `/api/tools`, `/api/sessions`, `/api/widget-snapshot`, `/api/sync/status`, and related aggregate routes.
3. **Non-awaiting behavior with blocked adapters** — when `syncKnownClaudeTranscripts` is held on a pending promise, concurrent GET `/api/overview` and `/api/tools` still return `200` without waiting for adapter completion.

These tests satisfy Phase 4's requirement that GET handlers do not invoke adapter sync or projection side effects. They do **not** by themselves prove the absolute §21 latency target (`committed aggregate GET < 500 ms while one adapter fixture is blocked in discovery`).

## Why the §21 blocked-adapter latency test is deferred

A faithful end-to-end latency fixture needs:

- a warm 100k+ event database per §21,
- a deliberately blocked adapter discovery path with stable timing,
- and repeated sequential sampling with discarded warm-up requests.

That combination is flaky in shared CI and was intentionally not added as a timing assertion in this gap-closure pass. The structural + spy coverage above is the deterministic substitute recorded for Phase 4 sign-off argumentation.

## Follow-up for full §21 evidence

Before performance sign-off, run the §21 fixture on a documented machine and attach:

- p95 aggregate endpoint latency with no sync running,
- committed aggregate GET latency while one adapter remains blocked,
- query-plan excerpts for widget snapshot and aggregate endpoints.

Increasing HTTP client timeouts is not acceptable performance evidence.
