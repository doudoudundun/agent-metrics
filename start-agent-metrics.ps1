[CmdletBinding()]
param(
  [switch]$Rebuild,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CorePort = 4318
$DashboardPort = 4173
$CoreUrl = "http://127.0.0.1:$CorePort/api/overview"
$DashboardUrl = "http://127.0.0.1:$DashboardPort"
$RuntimeDir = Join-Path $RepoRoot ".runtime"
$HookWatcherOutLog = Join-Path $RuntimeDir "hook-watcher.out.log"
$HookWatcherErrLog = Join-Path $RuntimeDir "hook-watcher.err.log"
$HookWatcherPidPath = Join-Path $RuntimeDir "hook-watcher.pid"
$ParserOutLog = Join-Path $RuntimeDir "parser.out.log"
$ParserErrLog = Join-Path $RuntimeDir "parser.err.log"
$ParserPidPath = Join-Path $RuntimeDir "parser.pid"
$CoreOutLog = Join-Path $RuntimeDir "core.out.log"
$CoreErrLog = Join-Path $RuntimeDir "core.err.log"
$DashboardOutLog = Join-Path $RuntimeDir "dashboard.out.log"
$DashboardErrLog = Join-Path $RuntimeDir "dashboard.err.log"
$CliWorkingDir = Join-Path $RepoRoot "apps\\cli"
$CoreWorkingDir = Join-Path $RepoRoot "apps\\core"
$DashboardWorkingDir = Join-Path $RepoRoot "apps\\dashboard"
$CliEntry = Join-Path $CliWorkingDir "dist\\index.js"
$CoreEntry = Join-Path $CoreWorkingDir "dist\\server.js"
$ViteEntry = Join-Path $RepoRoot "node_modules\\vite\\bin\\vite.js"

function Write-Step([string]$Message) {
  Write-Host "==> $Message"
}

function Test-HttpHealthy([string]$Url, [scriptblock]$Validator) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
    return & $Validator $response
  } catch {
    return $false
  }
}

function Wait-UntilHealthy([string]$Name, [string]$Url, [scriptblock]$Validator, [string]$LogPath) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    if (Test-HttpHealthy -Url $Url -Validator $Validator) {
      return
    }

    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  if (Test-Path $LogPath) {
    Write-Host ""
    Write-Host "$Name log tail:"
    Get-Content $LogPath -Tail 40
  }

  throw "$Name did not become healthy in time."
}

function Ensure-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Invoke-RepoCommand([string[]]$Command) {
  & $Command[0] $Command[1..($Command.Length - 1)]
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $($Command -join ' ')"
  }
}

function Ensure-Bootstrap() {
  Ensure-Command -Name "node"
  Ensure-Command -Name "corepack"

  if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
    Write-Step "Installing workspace dependencies"
    Push-Location $RepoRoot
    try {
      Invoke-RepoCommand -Command @("corepack", "pnpm", "install")
    } finally {
      Pop-Location
    }
  }

  if ($Rebuild -or -not (Test-Path $CliEntry) -or -not (Test-Path $CoreEntry) -or -not (Test-Path $ViteEntry)) {
    Write-Step "Building workspace packages"
    Push-Location $RepoRoot
    try {
      Invoke-RepoCommand -Command @("corepack", "pnpm", "build")
    } finally {
      Pop-Location
    }
  }
}

function Ensure-ClaudeHooks() {
  Write-Step "Ensuring Claude hooks"
  Push-Location $CliWorkingDir
  try {
    Invoke-RepoCommand -Command @("node", "dist/index.js", "hooks", "ensure", "--scope", "global", "--repo-root", $RepoRoot)
  } finally {
    Pop-Location
  }
}

function Get-ManagedHookWatcherPid() {
  if (-not (Test-Path $HookWatcherPidPath)) {
    return $null
  }

  $rawPid = (Get-Content $HookWatcherPidPath -Raw).Trim()

  if ($rawPid -notmatch '^\d+$') {
    Remove-Item $HookWatcherPidPath -ErrorAction SilentlyContinue
    return $null
  }

  $managedPid = [int]$rawPid
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue

  if (
    $null -eq $process -or
    $process.Name -ne "node.exe" -or
    $process.CommandLine -notmatch "hooks\s+watch" -or
    $process.CommandLine -notlike "*$RepoRoot*"
  ) {
    Remove-Item $HookWatcherPidPath -ErrorAction SilentlyContinue
    return $null
  }

  return $managedPid
}

function Start-HookWatcherIfNeeded() {
  $existingPid = Get-ManagedHookWatcherPid

  if ($null -ne $existingPid) {
    Write-Step "Hook watcher already running with PID $existingPid"
    return
  }

  Write-Step "Starting Claude hook watcher"
  $process = Start-Process -FilePath "node" `
    -ArgumentList @("dist/index.js", "hooks", "watch", "--scope", "global", "--repo-root", $RepoRoot) `
    -WorkingDirectory $CliWorkingDir `
    -RedirectStandardOutput $HookWatcherOutLog `
    -RedirectStandardError $HookWatcherErrLog `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Seconds 1

  if ($process.HasExited) {
    if (Test-Path $HookWatcherErrLog) {
      Write-Host ""
      Write-Host "Hook watcher log tail:"
      Get-Content $HookWatcherErrLog -Tail 40
    }

    throw "Claude hook watcher did not stay running."
  }

  Set-Content -Path $HookWatcherPidPath -Value "$($process.Id)" -NoNewline
  Write-Step "Hook watcher started with PID $($process.Id)"
}

function Get-ManagedParserPid() {
  if (-not (Test-Path $ParserPidPath)) {
    return $null
  }

  $rawPid = (Get-Content $ParserPidPath -Raw).Trim()

  if ($rawPid -notmatch '^\d+$') {
    Remove-Item $ParserPidPath -ErrorAction SilentlyContinue
    return $null
  }

  $managedPid = [int]$rawPid
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue

  if (
    $null -eq $process -or
    $process.Name -ne "node.exe" -or
    $process.CommandLine -notmatch "hooks\s+parse" -or
    $process.CommandLine -notlike "*$RepoRoot*"
  ) {
    Remove-Item $ParserPidPath -ErrorAction SilentlyContinue
    return $null
  }

  return $managedPid
}

function Start-ParserIfNeeded() {
  $existingPid = Get-ManagedParserPid

  if ($null -ne $existingPid) {
    Write-Step "Parser already running with PID $existingPid"
    return
  }

  Write-Step "Starting raw hook parser"
  $process = Start-Process -FilePath "node" `
    -ArgumentList @("dist/index.js", "hooks", "parse", "--follow", "--repo-root", $RepoRoot) `
    -WorkingDirectory $CliWorkingDir `
    -RedirectStandardOutput $ParserOutLog `
    -RedirectStandardError $ParserErrLog `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Seconds 1

  if ($process.HasExited) {
    if (Test-Path $ParserErrLog) {
      Write-Host ""
      Write-Host "Parser log tail:"
      Get-Content $ParserErrLog -Tail 40
    }

    throw "Parser did not stay running."
  }

  Set-Content -Path $ParserPidPath -Value "$($process.Id)" -NoNewline
  Write-Step "Parser started with PID $($process.Id)"
}

function Start-CoreIfNeeded() {
  $coreHealthy = Test-HttpHealthy -Url $CoreUrl -Validator {
    param($Response)
    $json = $Response.Content | ConvertFrom-Json
    return $null -ne $json.sessionCount
  }

  if ($coreHealthy) {
    Write-Step "Core API already running at $CoreUrl"
    return
  }

  if (Get-NetTCPConnection -LocalPort $CorePort -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $CorePort is already in use, but the Agent Metrics core health check failed."
  }

  Write-Step "Starting core API"
  $process = Start-Process -FilePath "node" `
    -ArgumentList @("dist/server.js") `
    -WorkingDirectory $CoreWorkingDir `
    -RedirectStandardOutput $CoreOutLog `
    -RedirectStandardError $CoreErrLog `
    -WindowStyle Hidden `
    -PassThru

  Wait-UntilHealthy -Name "Core API" -Url $CoreUrl -Validator {
    param($Response)
    $json = $Response.Content | ConvertFrom-Json
    return $null -ne $json.sessionCount
  } -LogPath $CoreErrLog

  Write-Step "Core API started with PID $($process.Id)"
}

function Start-DashboardIfNeeded() {
  $dashboardHealthy = Test-HttpHealthy -Url $DashboardUrl -Validator {
    param($Response)
    return $Response.Content -match "<title>Agent Metrics</title>"
  }

  if ($dashboardHealthy) {
    Write-Step "Dashboard already running at $DashboardUrl"
    return
  }

  if (Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $DashboardPort is already in use, but the Agent Metrics dashboard health check failed."
  }

  Write-Step "Starting dashboard"
  $process = Start-Process -FilePath "node" `
    -ArgumentList @($ViteEntry, "--host", "127.0.0.1", "--port", "$DashboardPort") `
    -WorkingDirectory $DashboardWorkingDir `
    -RedirectStandardOutput $DashboardOutLog `
    -RedirectStandardError $DashboardErrLog `
    -WindowStyle Hidden `
    -PassThru

  Wait-UntilHealthy -Name "Dashboard" -Url $DashboardUrl -Validator {
    param($Response)
    return $Response.Content -match "<title>Agent Metrics</title>"
  } -LogPath $DashboardErrLog

  Write-Step "Dashboard started with PID $($process.Id)"
}

if (-not (Test-Path $RuntimeDir)) {
  New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
}

Ensure-Bootstrap
Ensure-ClaudeHooks
Start-HookWatcherIfNeeded
Start-ParserIfNeeded
Start-CoreIfNeeded
Start-DashboardIfNeeded

Write-Host ""
Write-Host "Hooks:     ensured + watcher active"
Write-Host "Parser:    raw hook bus -> normalized events"
Write-Host "Dashboard: $DashboardUrl"
Write-Host "API:       $CoreUrl"
Write-Host "Logs:      $RuntimeDir"
Write-Host ""
Write-Host "Next step: open Claude Code in a test workspace and trigger Read, Search/Grep, Edit, and Bash."
Write-Host "Manual fallback: .\install-claude-hooks.ps1"
Write-Host "Expected logs:"
Write-Host "  data\hooks\raw\claude-code.jsonl"
Write-Host "  data\events\events.jsonl"
Write-Host "  data\hooks\state\parser-state.json"

if (-not $NoBrowser) {
  Start-Process $DashboardUrl | Out-Null
}
