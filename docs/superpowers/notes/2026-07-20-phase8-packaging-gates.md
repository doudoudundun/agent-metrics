# Phase 8 packaging gates (2026-07-20)

Spec: `docs/superpowers/specs/2026-07-17-agent-metrics-architecture-desktop-widget-refactor-design.md` §18–19 / Phase 8.

## Root `package:desktop:*` delegation

Root `package.json` forwards to `@agent-metrics/desktop` scripts; each desktop target chains **prepare-runtime → electron-builder → verify:package → smoke:package**:

| Root script | Desktop script | verify + smoke |
|---|---|---|
| `package:desktop:mac` | `package:mac` → `package:mac:arm64` | yes |
| `package:desktop:mac:x64` | `package:mac:x64` | yes |
| `package:desktop:mac:arm64` | `package:mac:arm64` | yes |
| `package:desktop:win` | `package:win` → `package:win:x64` | yes |
| `package:desktop:win:x64` | `package:win:x64` | yes |
| `package:desktop:win:arm64` | `package:win:arm64` | yes |

Standalone gates remain available without packaging:

- `pnpm --filter @agent-metrics/desktop run verify:package -- --target-platform=… --target-arch=…`
- `pnpm --filter @agent-metrics/desktop run smoke:package -- --target-platform=… --target-arch=…`

## Script responsibilities

| Script | Owner | Responsibility |
|---|---|---|
| `prepare-runtime` (`stage-runtime.mjs`) | Desktop packaging | Stage runtime for an explicit `--target-platform` / `--target-arch`; rebuild/obtain Node and native modules for that target; fail on unsatisfiable host/target mismatch |
| `verify:package` (`verify-package.mjs`) | Desktop packaging | Manifest/file allowlist assertions; exclude tests, design docs, temp files, local telemetry; binary/architecture checks |
| `smoke:package` (`smoke-package.mjs`) | Desktop packaging | Core `/api/health` (`apiVersion: 2`, `eventSchemaVersion: 2`); Dashboard HTML load; optional native Main/Widget smoke when `AGENT_METRICS_RUN_NATIVE_SMOKE=1`; writes evidence JSON under `docs/superpowers/notes/evidence/` |

## `package:*` wiring (current)

`apps/desktop/package.json` chains packaging targets as:

```text
clean-release → prepare-runtime --target-platform=… --target-arch=…
  → electron-builder
  → verify:package --target-platform=… --target-arch=…
  → smoke:package --target-platform=… --target-arch=…
```

Covered aliases:

- `package:win:x64`, `package:win:arm64`
- `package:mac:x64`, `package:mac:arm64`
- `package:win` delegates to `package:win:x64`; `package:mac` delegates to `package:mac:arm64`

`smoke:package` may skip native Main/Widget execution when no desktop session is available; set `AGENT_METRICS_RUN_NATIVE_SMOKE=1` on a host that can launch packaged windows. Content verification and Core/Dashboard smoke still run without that flag and produce evidence with `nativeMainWidget: "skipped"`.

Default packaged artifact paths are resolved automatically (`release/win-unpacked` or `release/mac`) when `--artifact` is omitted.

## Native evidence ledger and sign-off

Track per-target native smoke in **[2026-07-20-phase8-native-evidence-ledger.md](./2026-07-20-phase8-native-evidence-ledger.md)**.

**Phase 8 sign-off requires all four ledger rows Passed.** Current progress:

- Windows x64 — **Passed** (`docs/superpowers/notes/evidence/smoke-win32-x64-2026-07-20.json`)
- Windows ARM64 / macOS x64 / macOS ARM64 — still open

For each target: packaged `better-sqlite3` load (via `verify:package`), Core health, Dashboard load, and Main/Widget creation smoke with `checks.nativeMainWidget: "passed"` in the committed evidence JSON. Skipped native rows do **not** satisfy sign-off.

`stage-runtime.mjs` runs `prune-runtime-artifacts.mjs` after each deploy so `*.test.*` / docs / maps never enter the packaged runtime.

Manual CI: `.github/workflows/native-package-smoke.yml` (`workflow_dispatch`) covers Windows x64 and macOS ARM64 on GitHub-hosted runners. Windows ARM64 and macOS x64 require matching native hosts (see ledger commands).

## §18 runtime supervisor test coverage

Spec section 18 requires fake-clock/process-fixture tests for restart policy, readiness, external ownership, shutdown escalation, and single-timer behavior. Current automated coverage in `apps/desktop/src/runtime/runtime-supervisor.test.ts`:

| §18 rule | Covered | Notes |
|---|---|---|
| Fixed restart delays / child isolation | yes | restart policy + isolation test |
| Fifth-restart latch in rolling window | yes | latch test |
| Stable-run reset (5 min) | yes | stable reset test |
| Explicit `restart-runtime` recovery | yes | explicit restart clears latch |
| Readiness timeout (15 s) | yes | readiness timeout test |
| External Core reuse + no signal on shutdown | yes | external reuse test |
| External version rejection → managed spawn | yes | rejects unhealthy external runtime |
| Single restart timer per child | yes | duplicate exit emits one restart |
| Shutdown cancels restart timers | yes | cancel timers on stop |
| Graceful then forced shutdown (5 s) | yes | SIGTERM → SIGKILL escalation |
| **Platform-branching process-tree kill** | **yes** | Windows `taskkill /T /F` test + POSIX process-group `process.kill(-pgid)` test (`defaultForceKillProcessTree` + `forceKillProcessTree` injection); children spawned `detached:true` on POSIX so the PID is the group leader |
| **Child log rotation (5 MiB × 3) + rotation-failure → degraded** | **yes** | `rotateChildLog` propagates non-ENOENT errors; `markLogWriteFailed` sets `tracker.logWriteFailed` + `errorSummary` and `refreshState()` flips the runtime to `degraded`; dedicated fixture test writes against an unwritable dataRoot |
| Renderer error sanitization | partial | `sanitizeErrorSummary` unit test only |

`process-supervisor.test.ts` adds integration coverage for external health probing. The §18 supervisor (`runtime-supervisor.ts`) now satisfies every quantitative rule with an automated fixture test. The only remaining Phase 8 blocker is native macOS smoke execution evidence (see native-evidence-ledger), which cannot run on a win32 host.
