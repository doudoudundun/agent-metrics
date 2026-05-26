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
$CoreOutLog = Join-Path $RuntimeDir "core.out.log"
$CoreErrLog = Join-Path $RuntimeDir "core.err.log"
$DashboardOutLog = Join-Path $RuntimeDir "dashboard.out.log"
$DashboardErrLog = Join-Path $RuntimeDir "dashboard.err.log"
$CoreWorkingDir = Join-Path $RepoRoot "apps\\core"
$DashboardWorkingDir = Join-Path $RepoRoot "apps\\dashboard"
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

  if ($Rebuild -or -not (Test-Path $CoreEntry) -or -not (Test-Path $ViteEntry)) {
    Write-Step "Building workspace packages"
    Push-Location $RepoRoot
    try {
      Invoke-RepoCommand -Command @("corepack", "pnpm", "build")
    } finally {
      Pop-Location
    }
  }
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
Start-CoreIfNeeded
Start-DashboardIfNeeded

Write-Host ""
Write-Host "Dashboard: $DashboardUrl"
Write-Host "API:       $CoreUrl"
Write-Host "Logs:      $RuntimeDir"
Write-Host ""
Write-Host "Next step: run .\install-claude-hooks.ps1 once to register global Claude hooks."
Write-Host "Then open Claude Code in a test workspace and trigger Read, Search/Grep, Edit, and Bash."
Write-Host "Expected logs:"
Write-Host "  data\hooks\raw\claude-code.jsonl"
Write-Host "  data\events\events.jsonl"

if (-not $NoBrowser) {
  Start-Process $DashboardUrl | Out-Null
}
