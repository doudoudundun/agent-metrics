import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const scriptPath = path.join(repoRoot, "start-agent-metrics.ps1");

describe("start-agent-metrics.ps1", () => {
  it("uses the shared data root for hook installation, parsing, and core storage", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("$DataRoot =");
    expect(script).toContain('$env:AGENT_METRICS_DATA_ROOT');
    expect(script).toContain('Join-Path $env:APPDATA "Agent Metrics\\agent-metrics-data"');
    expect(script).toContain('Join-Path $RepoRoot "data-runtime"');
    expect(script).toContain(
      'Invoke-RepoCommand -Command @($NodeExecutable, "dist/index.js", "hooks", "ensure", "--scope", "global", "--repo-root", $DataRoot, "--cli-path", $CliEntry)'
    );
    expect(script).toContain("function Join-ProcessArguments([string[]]$Arguments)");
    expect(script).toContain(
      '-ArgumentList (Join-ProcessArguments @("dist/index.js", "hooks", "watch", "--scope", "global", "--repo-root", $DataRoot, "--cli-path", $CliEntry))'
    );
    expect(script).toContain(
      '-ArgumentList (Join-ProcessArguments @("dist/index.js", "hooks", "parse", "--follow", "--repo-root", $DataRoot))'
    );
    expect(script).toContain('$env:AGENT_METRICS_DB_PATH = Join-Path $DataRoot "data\\sqlite\\metrics.sqlite"');
    expect(script).toContain(
      '$env:AGENT_METRICS_EVENT_LOG_PATH = Join-Path $DataRoot "data\\events\\events.jsonl"'
    );
    expect(script).toContain('$env:AGENT_METRICS_REPO_ROOT = $DataRoot');
    expect(script).not.toContain('$env:AGENT_METRICS_CORE_TRANSCRIPT_SYNC = "0"');
    expect(script).toContain('New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "data\\hooks\\raw")');
    expect(script).toContain('New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "data\\events")');
    expect(script).toContain('New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "data\\hooks\\state")');
    expect(script).toContain('New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "data\\sqlite")');
    expect(script).toContain('Write-Host "Data:      $DataRoot"');
  });
});
