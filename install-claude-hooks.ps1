[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location $RepoRoot
try {
  & corepack pnpm --filter @agent-metrics/cli build
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: corepack pnpm --filter @agent-metrics/cli build"
  }

  & node ".\apps\cli\dist\index.js" hooks ensure --scope global --repo-root $RepoRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: node .\\apps\\cli\\dist\\index.js hooks ensure --scope global --repo-root $RepoRoot"
  }
} finally {
  Pop-Location
}
