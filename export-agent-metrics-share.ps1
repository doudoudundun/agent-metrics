[CmdletBinding()]
param(
  [string]$OutputRoot = (Join-Path $env:TEMP "agent-metrics-share"),
  [switch]$Zip
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ExportDir = Join-Path $OutputRoot "agent-metrics-share-$Timestamp"
$ZipPath = "$ExportDir.zip"

$ExcludedDirectoryNames = @(
  ".git",
  ".runtime",
  ".vite",
  "coverage",
  "dist",
  "node_modules"
)

$ExcludedRelativeFilePatterns = @(
  '(^|[\\/])data[\\/]+events[\\/].+\.jsonl$',
  '(^|[\\/])data[\\/]+hooks[\\/]+raw[\\/].+\.jsonl$',
  '(^|[\\/])data[\\/]+hooks[\\/]+state[\\/].+\.json$',
  '(^|[\\/])data[\\/]+sources[\\/]+state[\\/].+\.json$',
  '(^|[\\/])data[\\/]+sqlite[\\/].+\.db$',
  '(^|[\\/])data[\\/]+sqlite[\\/].+\.sqlite$',
  '(^|[\\/])data[\\/]+sqlite[\\/].+\.sqlite-shm$',
  '(^|[\\/])data[\\/]+sqlite[\\/].+\.sqlite-wal$',
  '^\.tmp.*\.log$'
)

function Get-RelativePath([string]$BasePath, [string]$FullPath) {
  $relative = $FullPath.Substring($BasePath.Length)
  return $relative.TrimStart('\', '/')
}

function Split-PathSegments([string]$RelativePath) {
  return $RelativePath -split '[\\/]+' | Where-Object { $_.Length -gt 0 }
}

function Test-ExcludedDirectory([string]$RelativePath) {
  $segments = Split-PathSegments $RelativePath
  foreach ($segment in $segments) {
    if ($ExcludedDirectoryNames -contains $segment) {
      return $true
    }
  }

  return $false
}

function Test-ExcludedFile([string]$RelativePath) {
  if (Test-ExcludedDirectory $RelativePath) {
    return $true
  }

  foreach ($pattern in $ExcludedRelativeFilePatterns) {
    if ($RelativePath -match $pattern) {
      return $true
    }
  }

  return $false
}

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
New-Item -ItemType Directory -Path $ExportDir -Force | Out-Null

$CopiedFiles = 0

foreach ($file in Get-ChildItem -LiteralPath $RepoRoot -Recurse -Force -File) {
  $relativePath = Get-RelativePath -BasePath $RepoRoot -FullPath $file.FullName

  if (Test-ExcludedFile $relativePath) {
    continue
  }

  $targetPath = Join-Path $ExportDir $relativePath
  $targetDirectory = Split-Path -Parent $targetPath

  if (-not (Test-Path $targetDirectory)) {
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  }

  Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force
  $CopiedFiles += 1
}

if ($Zip) {
  if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
  }

  Compress-Archive -LiteralPath $ExportDir -DestinationPath $ZipPath -Force
}

Write-Host "Export created: $ExportDir"
Write-Host "Copied files: $CopiedFiles"

if ($Zip) {
  Write-Host "Zip archive: $ZipPath"
}

Write-Host ""
Write-Host "The export excludes local telemetry and runtime state:"
Write-Host "- data/events/*.jsonl"
Write-Host "- data/hooks/raw/*.jsonl"
Write-Host "- data/hooks/state/*.json"
Write-Host "- data/sources/state/*.json"
Write-Host "- data/sqlite/*.sqlite*"
Write-Host "- .runtime/"
