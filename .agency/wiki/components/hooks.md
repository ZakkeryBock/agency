# Claude Code hooks

## What it does
<!-- agency:ai -->
Does deterministic bookkeeping so the AI spends no tokens on it: file→component mapping, event log, stale marking. The Stop hook nudges the AI once per turn to refresh only what changed.
<!-- /agency:ai -->

## Notes

## Gotchas
<!-- agency:ai -->
Edits made through Bash (sed, scripts) are invisible to PostToolUse; the git post-commit hook catches them and attributes them as inferred.
<!-- /agency:ai -->
