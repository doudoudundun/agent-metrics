import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const scriptPath = path.join(repoRoot, "install-claude-hooks.ps1");

describe("install-claude-hooks.ps1", () => {
  it("installs hooks against the shared data root with the repo CLI entrypoint", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("$DataRoot =");
    expect(script).toContain('$env:AGENT_METRICS_DATA_ROOT');
    expect(script).toContain('Join-Path $env:APPDATA "Agent Metrics\\agent-metrics-data"');
    expect(script).toContain('Join-Path $RepoRoot "data-runtime"');
    expect(script).toContain('$CliEntry = Join-Path $RepoRoot "apps\\cli\\dist\\index.js"');
    expect(script).toContain('& node ".\\apps\\cli\\dist\\index.js" hooks ensure --scope global --repo-root $DataRoot --cli-path $CliEntry');
  });
});
