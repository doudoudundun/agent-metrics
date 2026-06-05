[CmdletBinding()]
param(
  [switch]$Rebuild,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfiguredNodePath = $env:AGENT_METRICS_NODE_PATH
$NodeExecutable = $null
$NodeResolutionSource = $null
$CorePort = if ($env:AGENT_METRICS_CORE_PORT) { [int]$env:AGENT_METRICS_CORE_PORT } else { 45183 }
$DashboardPort = if ($env:AGENT_METRICS_DASHBOARD_PORT) { [int]$env:AGENT_METRICS_DASHBOARD_PORT } else { 4173 }
$CoreUrl = "http://127.0.0.1:$CorePort/api/overview"
$DashboardUrl = "http://127.0.0.1:$DashboardPort"
$DashboardApiUrl = "$DashboardUrl/api/overview"
$RuntimeDir = Join-Path $RepoRoot ".runtime"
$HookWatcherOutLog = Join-Path $RuntimeDir "hook-watcher.out.log"
$HookWatcherErrLog = Join-Path $RuntimeDir "hook-watcher.err.log"
$HookWatcherPidPath = Join-Path $RuntimeDir "hook-watcher.pid"
$ParserOutLog = Join-Path $RuntimeDir "parser.out.log"
$ParserErrLog = Join-Path $RuntimeDir "parser.err.log"
$ParserPidPath = Join-Path $RuntimeDir "parser.pid"
$CoreOutLog = Join-Path $RuntimeDir "core.out.log"
$CoreErrLog = Join-Path $RuntimeDir "core.err.log"
$CorePidPath = Join-Path $RuntimeDir "core.pid"
$DashboardOutLog = Join-Path $RuntimeDir "dashboard.out.log"
$DashboardErrLog = Join-Path $RuntimeDir "dashboard.err.log"
$DashboardPidPath = Join-Path $RuntimeDir "dashboard.pid"
$CliWorkingDir = Join-Path $RepoRoot "apps\\cli"
$CoreWorkingDir = Join-Path $RepoRoot "apps\\core"
$DashboardWorkingDir = Join-Path $RepoRoot "apps\\dashboard"
$CliEntry = Join-Path $CliWorkingDir "dist\\index.js"
$CoreEntry = Join-Path $CoreWorkingDir "dist\\server.js"
$ViteEntry = Join-Path $RepoRoot "node_modules\\vite\\bin\\vite.js"
$ManagedNodeVersion = if ($env:AGENT_METRICS_NODE_VERSION) { $env:AGENT_METRICS_NODE_VERSION } else { "22.22.3" }
$ManagedNodeFolder = "node-v$ManagedNodeVersion-win-x64"
$ManagedNodeDir = Join-Path $RuntimeDir $ManagedNodeFolder
$ManagedNodeExecutable = Join-Path $ManagedNodeDir "node.exe"
$ManagedNodeArchive = Join-Path $RuntimeDir "$ManagedNodeFolder.zip"
$ManagedNodeDownloadUrl = "https://nodejs.org/dist/v$ManagedNodeVersion/$ManagedNodeFolder.zip"
$CorepackEntrypoint = $null
$BetterSqlitePackageDir = Join-Path $RepoRoot "node_modules\\.pnpm\\better-sqlite3@11.10.0\\node_modules\\better-sqlite3"

if (-not (Test-Path $RuntimeDir)) {
  New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
}

function Write-Step([string]$Message) {
  Write-Host "==> $Message"
}

function Get-NodeRoot([string]$NodePath) {
  $nodeDir = Split-Path -Parent $NodePath

  if ((Split-Path -Leaf $nodeDir) -eq "bin") {
    return (Split-Path -Parent $nodeDir)
  }

  return $nodeDir
}

function Ensure-ManagedNodeRuntime() {
  if (Test-Path -LiteralPath $ManagedNodeExecutable) {
    return
  }

  Write-Step "Downloading stable Node.js v$ManagedNodeVersion runtime"
  Invoke-WebRequest -UseBasicParsing -Uri $ManagedNodeDownloadUrl -OutFile $ManagedNodeArchive
  Expand-Archive -LiteralPath $ManagedNodeArchive -DestinationPath $RuntimeDir -Force

  if (-not (Test-Path -LiteralPath $ManagedNodeExecutable)) {
    throw "Managed Node runtime download completed, but node.exe was not found: $ManagedNodeExecutable"
  }
}

function Resolve-NodeExecutable() {
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredNodePath)) {
    if (-not (Test-Path -LiteralPath $ConfiguredNodePath)) {
      throw "Configured Node executable was not found: $ConfiguredNodePath"
    }

    $script:NodeResolutionSource = "AGENT_METRICS_NODE_PATH"
    return (Resolve-Path -LiteralPath $ConfiguredNodePath).Path
  }

  try {
    Ensure-ManagedNodeRuntime
    $script:NodeResolutionSource = "managed-node-v$ManagedNodeVersion"
    return (Resolve-Path -LiteralPath $ManagedNodeExecutable).Path
  } catch {
    Write-Warning "Failed to prepare managed Node runtime: $($_.Exception.Message)"
  }

  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue

  if ($null -eq $nodeCommand) {
    throw "Node executable was not found. Set AGENT_METRICS_NODE_PATH or add node to PATH."
  }

  $resolvedPath =
    if ($nodeCommand.Source) {
      $nodeCommand.Source
    } elseif ($nodeCommand.Path) {
      $nodeCommand.Path
    } else {
      $nodeCommand.Definition
    }

  $script:NodeResolutionSource = "PATH"
  return (Resolve-Path -LiteralPath $resolvedPath).Path
}

function Resolve-CorepackEntrypoint([string]$NodePath) {
  $nodeRoot = Get-NodeRoot $NodePath
  $candidates = @(
    (Join-Path $nodeRoot "node_modules\\corepack\\dist\\corepack.js"),
    (Join-Path $nodeRoot "lib\\node_modules\\corepack\\dist\\corepack.js")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "Corepack entrypoint was not found for Node runtime: $NodePath"
}

function Test-OverviewContract($Json) {
  return (
    $null -ne $Json -and
    $null -ne $Json.sessionCount -and
    $null -ne $Json.turnCount -and
    $null -ne $Json.totalTokens -and
    ($Json.PSObject.Properties.Name -contains "tokensByModel") -and
    $null -ne $Json.tokensByModel -and
    $Json.tokensByModel -is [System.Array]
  )
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

function Test-DashboardHealthy() {
  $shellHealthy = Test-HttpHealthy -Url $DashboardUrl -Validator {
    param($Response)
    return $Response.Content -match "<title>Agent Metrics</title>"
  }

  if (-not $shellHealthy) {
    return $false
  }

  return Test-HttpHealthy -Url $DashboardApiUrl -Validator {
    param($Response)
    $json = $Response.Content | ConvertFrom-Json
    return Test-OverviewContract $json
  }
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

function Invoke-PnpmCommand([string[]]$Arguments) {
  $command = @($NodeExecutable, $CorepackEntrypoint, "pnpm") + $Arguments
  Invoke-RepoCommand -Command $command
}

function Resolve-PrebuildInstallEntrypoint() {
  $candidate = Get-ChildItem `
    -Path (Join-Path $RepoRoot "node_modules\\.pnpm") `
    -Filter "prebuild-install@*" `
    -Directory `
    -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1

  if ($null -eq $candidate) {
    throw "prebuild-install package was not found under node_modules\\.pnpm."
  }

  $entrypoint = Join-Path $candidate.FullName "node_modules\\prebuild-install\\bin.js"

  if (-not (Test-Path -LiteralPath $entrypoint)) {
    throw "prebuild-install entrypoint was not found: $entrypoint"
  }

  return $entrypoint
}

function Test-CoreNativeDependencies() {
  Push-Location $CoreWorkingDir
  try {
    & $NodeExecutable -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();"
    return $LASTEXITCODE -eq 0
  } finally {
    Pop-Location
  }
}

function Ensure-CoreNativeDependencies() {
  if (Test-CoreNativeDependencies) {
    return
  }

  $prebuildInstallEntrypoint = Resolve-PrebuildInstallEntrypoint

  Write-Step "Installing better-sqlite3 prebuilt binding for the selected Node runtime"
  Push-Location $BetterSqlitePackageDir
  try {
    Invoke-RepoCommand -Command @($NodeExecutable, $prebuildInstallEntrypoint, "--verbose")
  } finally {
    Pop-Location
  }

  if (Test-CoreNativeDependencies) {
    return
  }

  Write-Step "Falling back to pnpm rebuild for better-sqlite3"
  Push-Location $RepoRoot
  try {
    Invoke-PnpmCommand -Arguments @("rebuild", "better-sqlite3")
  } finally {
    Pop-Location
  }

  if (-not (Test-CoreNativeDependencies)) {
    throw "better-sqlite3 is not compatible with $NodeExecutable. Set AGENT_METRICS_NODE_PATH to a compatible Node 22 runtime or install the required native build toolchain."
  }
}

function Ensure-Bootstrap() {
  $script:NodeExecutable = Resolve-NodeExecutable
  $script:CorepackEntrypoint = Resolve-CorepackEntrypoint $NodeExecutable

  if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) {
    Write-Step "Installing workspace dependencies"
    Push-Location $RepoRoot
    try {
      Invoke-PnpmCommand -Arguments @("install")
    } finally {
      Pop-Location
    }
  }

  if ($Rebuild -or -not (Test-Path $CliEntry) -or -not (Test-Path $CoreEntry) -or -not (Test-Path $ViteEntry)) {
    Write-Step "Building workspace packages"
    Push-Location $RepoRoot
    try {
      Invoke-PnpmCommand -Arguments @("build")
    } finally {
      Pop-Location
    }
  }

  Ensure-CoreNativeDependencies
}

function Ensure-ClaudeHooks() {
  Write-Step "Ensuring Claude hooks"
  Push-Location $CliWorkingDir
  try {
    Invoke-RepoCommand -Command @($NodeExecutable, "dist/index.js", "hooks", "ensure", "--scope", "global", "--repo-root", $RepoRoot)
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
  $process = Start-Process -FilePath $NodeExecutable `
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
  $process = Start-Process -FilePath $NodeExecutable `
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

function Get-ManagedCorePid() {
  if (Test-Path $CorePidPath) {
    $rawPid = (Get-Content $CorePidPath -Raw).Trim()

    if ($rawPid -match '^\d+$') {
      $managedPid = [int]$rawPid
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue

      if (
        $null -ne $process -and
        $process.Name -eq "node.exe" -and
        $process.CommandLine -match "dist[\\/]+server\.js"
      ) {
        return $managedPid
      }
    }

    Remove-Item $CorePidPath -ErrorAction SilentlyContinue
  }

  $connection = Get-NetTCPConnection -LocalPort $CorePort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($null -eq $connection) {
    return $null
  }

  $managedPid = [int]$connection.OwningProcess
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue

  if (
    $null -eq $process -or
    $process.Name -ne "node.exe" -or
    $process.CommandLine -notmatch "dist[\\/]+server\.js"
  ) {
    return $null
  }

  return $managedPid
}

function Start-CoreIfNeeded() {
  $coreHealthy = Test-HttpHealthy -Url $CoreUrl -Validator {
    param($Response)
    $json = $Response.Content | ConvertFrom-Json
    return Test-OverviewContract $json
  }

  if ($coreHealthy) {
    Write-Step "Core API already running at $CoreUrl"
    return
  }

  if (Get-NetTCPConnection -LocalPort $CorePort -State Listen -ErrorAction SilentlyContinue) {
    $managedPid = Get-ManagedCorePid

    if ($null -ne $managedPid) {
      Write-Step "Stopping stale core process with PID $managedPid"
      Stop-Process -Id $managedPid -Force
      Start-Sleep -Seconds 1
    }
  }

  if (Get-NetTCPConnection -LocalPort $CorePort -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $CorePort is already in use, but the Agent Metrics core health check failed."
  }

  Write-Step "Starting core API"
  $process = Start-Process -FilePath $NodeExecutable `
    -ArgumentList @("dist/server.js") `
    -WorkingDirectory $CoreWorkingDir `
    -RedirectStandardOutput $CoreOutLog `
    -RedirectStandardError $CoreErrLog `
    -WindowStyle Hidden `
    -PassThru

  Wait-UntilHealthy -Name "Core API" -Url $CoreUrl -Validator {
    param($Response)
    $json = $Response.Content | ConvertFrom-Json
    return Test-OverviewContract $json
  } -LogPath $CoreErrLog

  Set-Content -Path $CorePidPath -Value "$($process.Id)" -NoNewline
  Write-Step "Core API started with PID $($process.Id)"
}

function Get-ManagedDashboardPid() {
  if (Test-Path $DashboardPidPath) {
    $rawPid = (Get-Content $DashboardPidPath -Raw).Trim()

    if ($rawPid -match '^\d+$') {
      $managedPid = [int]$rawPid
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue

      if (
        $null -ne $process -and
        $process.Name -eq "node.exe" -and
        $process.CommandLine -like "*$RepoRoot*" -and
        $process.CommandLine -match "vite(\.js)?"
      ) {
        return $managedPid
      }
    }

    Remove-Item $DashboardPidPath -ErrorAction SilentlyContinue
  }

  $connection = Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($null -eq $connection) {
    return $null
  }

  $managedPid = [int]$connection.OwningProcess
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue

  if (
    $null -eq $process -or
    $process.Name -ne "node.exe" -or
    $process.CommandLine -notlike "*$RepoRoot*" -or
    $process.CommandLine -notmatch "vite(\.js)?"
  ) {
    return $null
  }

  return $managedPid
}

function Start-DashboardIfNeeded() {
  $dashboardHealthy = Test-DashboardHealthy

  if ($dashboardHealthy) {
    Write-Step "Dashboard already running at $DashboardUrl"
    return
  }

  if (Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction SilentlyContinue) {
    $managedPid = Get-ManagedDashboardPid

    if ($null -ne $managedPid) {
      Write-Step "Stopping stale dashboard process with PID $managedPid"
      Stop-Process -Id $managedPid -Force
      Start-Sleep -Seconds 1
    }
  }

  if (Get-NetTCPConnection -LocalPort $DashboardPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $DashboardPort is already in use, but the Agent Metrics dashboard proxy health check failed."
  }

  Write-Step "Starting dashboard"
  $process = Start-Process -FilePath $NodeExecutable `
    -ArgumentList @($ViteEntry, "--host", "127.0.0.1", "--port", "$DashboardPort") `
    -WorkingDirectory $DashboardWorkingDir `
    -RedirectStandardOutput $DashboardOutLog `
    -RedirectStandardError $DashboardErrLog `
    -WindowStyle Hidden `
    -PassThru

  Wait-UntilHealthy -Name "Dashboard" -Url $DashboardApiUrl -Validator {
    param($Response)
    $json = $Response.Content | ConvertFrom-Json
    return Test-OverviewContract $json
  } -LogPath $DashboardErrLog

  Set-Content -Path $DashboardPidPath -Value "$($process.Id)" -NoNewline
  Write-Step "Dashboard started with PID $($process.Id)"
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
Write-Host "Node:      $NodeExecutable ($NodeResolutionSource)"
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
