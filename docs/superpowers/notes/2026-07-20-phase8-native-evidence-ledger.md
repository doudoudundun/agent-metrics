# Phase 8 native smoke evidence ledger (2026-07-20)

Tracks packaged native Main/Widget smoke evidence for §19 sign-off. Evidence JSON files are written by `apps/desktop/scripts/smoke-package.mjs` under `docs/superpowers/notes/evidence/` as `smoke-{platform}-{arch}-{YYYY-MM-DD}.json`.

**Sign-off rule:** all four rows must reach **Passed** with `checks.nativeMainWidget: "passed"` in the evidence file. Core/Dashboard-only evidence (`nativeMainWidget: "skipped"`) does not satisfy Phase 8.

| Target | Status | Evidence file | Last updated |
|---|---|---|---|
| Windows x64 (`win32/x64`) | **Passed** | `docs/superpowers/notes/evidence/smoke-win32-x64-2026-07-20.json` | 2026-07-20 |
| Windows ARM64 (`win32/arm64`) | Pending | — | — |
| macOS x64 (`darwin/x64`) | Pending | — | — |
| macOS ARM64 (`darwin/arm64`) | Pending | — | — |

## How to fill a row

Run on a **native host matching the target** (packaging and native smoke cannot cross-compile). Set `AGENT_METRICS_RUN_NATIVE_SMOKE=1` so the packaged app launches with `AGENT_METRICS_DESKTOP_SMOKE=1`, verifies Main/Widget windows, and writes `desktop-smoke-ok.json` before exit.

After a successful run, commit the generated evidence JSON and update the table above to **Passed** with the filename and date.

### Windows x64

```powershell
cd d:\projects\dev\agent-metrics
corepack enable
corepack pnpm install
corepack pnpm build
$env:AGENT_METRICS_RUN_NATIVE_SMOKE = "1"
corepack pnpm package:desktop:win:x64
```

### Windows ARM64

Requires a Windows on ARM64 machine (or ARM64 Windows VM):

```powershell
cd d:\projects\dev\agent-metrics
corepack enable
corepack pnpm install
corepack pnpm build
$env:AGENT_METRICS_RUN_NATIVE_SMOKE = "1"
corepack pnpm package:desktop:win:arm64
```

### macOS x64

Requires an Intel Mac or Rosetta-capable environment with x64 Node/runtime staging:

```bash
cd /path/to/agent-metrics
corepack enable
corepack pnpm install
corepack pnpm build
AGENT_METRICS_RUN_NATIVE_SMOKE=1 corepack pnpm package:desktop:mac:x64
```

### macOS ARM64

```bash
cd /path/to/agent-metrics
corepack enable
corepack pnpm install
corepack pnpm build
AGENT_METRICS_RUN_NATIVE_SMOKE=1 corepack pnpm package:desktop:mac:arm64
```

## CI shortcut

`.github/workflows/native-package-smoke.yml` (manual `workflow_dispatch`) runs native smoke on GitHub-hosted runners for **Windows x64** and **macOS ARM64** only. Windows ARM64 and macOS x64 still require the matching native hosts above (or future matrix expansion).

## Evidence schema (reference)

```json
{
  "platform": "win32",
  "arch": "x64",
  "hostPlatform": "win32",
  "hostArch": "x64",
  "timestamp": "2026-07-20T02:00:00.000Z",
  "artifact": ".../apps/desktop/release/win-unpacked",
  "checks": {
    "verifyPackage": "passed",
    "coreHealth": "passed",
    "dashboardLoad": "passed",
    "nativeMainWidget": "passed"
  },
  "node": {
    "host": "v22.x.x",
    "bundled": "22.22.3"
  }
}
```

When native smoke is skipped, `checks.nativeMainWidget` is `"skipped"` and `nativeSkipReason` explains why.
