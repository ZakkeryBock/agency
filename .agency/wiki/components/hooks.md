# Claude Code hooks

## What it does
<!-- agency:ai -->
Does deterministic bookkeeping so the AI spends no tokens on it: file→component mapping, event log, stale marking. The Stop hook nudges the AI once per turn to refresh only what changed.
<!-- /agency:ai -->

## Notes

## Gotchas
<!-- agency:ai -->
Recognises plugin tool names mcp__plugin_agency_agency__*; SessionStart hints to run init --plugin when no .agency/.
<!-- /agency:ai -->
