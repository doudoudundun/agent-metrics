[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataRoot =
  if ($env:AGENT_METRICS_DATA_ROOT) {
    $env:AGENT_METRICS_DATA_ROOT
  } elseif ($env:APPDATA) {
    Join-Path $env:APPDATA "Agent Metrics\agent-metrics-data"
  } else {
    Join-Path $RepoRoot "data-runtime"
  }
$CliEntry = Join-Path $RepoRoot "apps\cli\dist\index.js"

Push-Location $RepoRoot
try {
  & corepack pnpm --filter @agent-metrics/cli build
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: corepack pnpm --filter @agent-metrics/cli build"
  }

  & node ".\apps\cli\dist\index.js" hooks ensure --scope global --repo-root $DataRoot --cli-path $CliEntry
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: node .\\apps\\cli\\dist\\index.js hooks ensure --scope global --repo-root $DataRoot --cli-path $CliEntry"
  }
} finally {
  Pop-Location
}
