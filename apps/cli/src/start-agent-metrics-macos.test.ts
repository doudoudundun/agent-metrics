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
});
