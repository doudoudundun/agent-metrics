# Phase 6 dashboard visual gates (2026-07-20)

## Context

Spec: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md` (Phase 6 exit criteria)

Playwright viewport matrix lives in `apps/dashboard/e2e/dashboard-viewport.spec.ts` with snapshots under
`apps/dashboard/e2e/dashboard-viewport.spec.ts-snapshots/`.

## Baseline generation

Win32 PNG baselines for the five Phase 6 viewports are checked in under
`apps/dashboard/e2e/dashboard-viewport.spec.ts-snapshots/` (`*-win32.png`).

Regenerate in an isolated environment after intentional visual changes:

```bash
corepack pnpm --filter @agent-metrics/dashboard test:e2e:update
```

Compare without updating:

```bash
corepack pnpm --filter @agent-metrics/dashboard test:e2e
```

Root shortcut: `corepack pnpm test:dashboard:e2e`.

Playwright appends the host platform to snapshot names. CI visual jobs should run on `windows-latest` (or regenerate/commit `*-linux.png` / `*-darwin.png` when those hosts are required).

## Status (2026-07-20)

- Vitest: seven health-status fixtures + axe (critical/serious) + chrome tab-order assertions — green in TEMP sandbox.
- Playwright: viewport matrix generated and verified once with `--update-snapshots` on Windows x64.

## Pinned tooling

- `@playwright/test` ^1.52 (root `devDependencies`; resolved 1.61.x in lockfile)
- `axe-core` ^4.10.3 (Vitest accessibility fixtures in `DashboardPage.test.tsx`)
