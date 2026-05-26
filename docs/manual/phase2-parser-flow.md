# Phase 2 Parser Flow

## Runtime model

- Claude Code hooks write raw envelopes to `data/hooks/raw/claude-code.jsonl`.
- `node .\apps\cli\dist\index.js hooks parse --follow --repo-root <repo>` tails the raw file and writes normalized events to `data/events/events.jsonl`.
- `apps/core` ingests normalized events into SQLite when the API is requested.
- `apps/dashboard` reads from the API and shows the current hook-derived metrics.

## Startup

- Preferred: `.\start-agent-metrics.ps1`
- The startup script now manages three local processes:
  - parser follow loop
  - core API
  - dashboard dev server

## Recovery

Use this when raw envelopes keep growing but normalized events stop changing:

1. Stop the managed parser process recorded in `.runtime\parser.pid`.
2. Delete `data/hooks/state/parser-state.json`.
3. Re-run one-shot parsing:

```powershell
node .\apps\cli\dist\index.js hooks parse --repo-root D:\projects\dev\agent-metrics
```

4. Restart `.\start-agent-metrics.ps1`.

## Files to inspect

- `data/hooks/raw/claude-code.jsonl`
- `data/events/events.jsonl`
- `data/hooks/state/parser-state.json`
- `.runtime/parser.out.log`
- `.runtime/parser.err.log`
