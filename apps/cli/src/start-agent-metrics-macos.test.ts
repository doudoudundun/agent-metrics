import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const scriptPath = path.join(repoRoot, "start-agent-metrics.sh");

describe("start-agent-metrics.sh", () => {
  it("starts Vite via its JavaScript entrypoint on macOS", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('VITE_ENTRY="$REPO_ROOT/node_modules/vite/bin/vite.js"');
    expect(script).toContain('node "$VITE_ENTRY" --host 127.0.0.1 --port "$DASHBOARD_PORT"');
    expect(script).not.toContain('node "$REPO_ROOT/node_modules/.bin/vite"');
  });

  it("runs background processes from their declared working directory", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("nohup bash -lc '");
    expect(script).toContain('cd "$1"');
    expect(script).toContain(`' bash "$working_dir" "$@" >"$out_log" 2>"$err_log" &`);
  });

  it("uses the shared data root for hook installation, parsing, and core storage", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(
      'DATA_ROOT="${AGENT_METRICS_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/Agent Metrics/agent-metrics-data}"'
    );
    expect(script).toContain('mkdir -p "$DATA_ROOT/data/hooks/raw"');
    expect(script).toContain('mkdir -p "$DATA_ROOT/data/events"');
    expect(script).toContain('mkdir -p "$DATA_ROOT/data/hooks/state"');
    expect(script).toContain('mkdir -p "$DATA_ROOT/data/sqlite"');
    expect(script).toContain(
      '(cd "$CLI_WORKING_DIR" && node "$CLI_ENTRY" hooks ensure --scope global --repo-root "$DATA_ROOT" --cli-path "$CLI_ENTRY")'
    );
    expect(script).toContain(
      'node "$CLI_ENTRY" hooks watch --scope global --repo-root "$DATA_ROOT" --cli-path "$CLI_ENTRY"'
    );
    expect(script).toContain('node "$CLI_ENTRY" hooks parse --follow --repo-root "$DATA_ROOT"');
    expect(script).toContain('"AGENT_METRICS_DB_PATH=$DATA_ROOT/data/sqlite/metrics.sqlite"');
    expect(script).toContain('"AGENT_METRICS_EVENT_LOG_PATH=$DATA_ROOT/data/events/events.jsonl"');
    expect(script).toContain('"AGENT_METRICS_REPO_ROOT=$DATA_ROOT"');
    expect(script).toContain('info "Data:      $DATA_ROOT"');
  });
});
