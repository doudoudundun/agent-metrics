# Phase 0 package smoke baseline (2026-07-20)

## Context

Spec: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md`

This is a baseline record only. It is **not** a Phase 8 completion signal — it just
notes how Phase 0 "package smoke" verification is currently being handled while
Phase 2 (schema version 2 write-path migration) is underway on this branch.

## Branch / platform

- Branch: `feat/dashboard-time-scopes`
- Platform: Windows (win32 10.0.22631), PowerShell shell

## Decision

Phase 0 package smoke is deferred to the existing desktop scripts rather than
publishing new packaging artifacts from this session:

- `pnpm --filter @agent-metrics/desktop run prepare-runtime` (`apps/desktop/scripts/stage-runtime.mjs`)
- `pnpm --filter @agent-metrics/desktop run verify:package` (`apps/desktop/scripts/verify-package.mjs`)
- `pnpm --filter @agent-metrics/desktop run smoke:package` (`apps/desktop/scripts/smoke-package.mjs`)

These scripts already exist on the branch and cover staging the runtime,
verifying the packaged output, and smoke-testing the packaged app. No new
build/package artifacts were produced or published as part of this note; this
document only records that the existing scripts are the intended verification
path for Phase 0 and that they have not been re-run here to avoid locking the
user's workspace (per session constraints, compile/build/test commands that
touch the user's working tree were intentionally skipped in this session).

## Follow-up

Before Phase 8 (release) sign-off, actually run the three scripts above on
Windows (and any other target platforms in scope) and attach their output to
the Phase 8 completion record. This note does not satisfy that requirement.
