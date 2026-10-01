# Installer

## What it does
<!-- agency:ai -->
Idempotent: re-running `agency init` never duplicates hooks or AGENTS.md sections.
<!-- /agency:ai -->

## Notes

## Gotchas
<!-- agency:ai -->
init now emits `npx -y agency-dev ...` (cmd /c npx on Windows) for MCP, hooks, git hook. Package must be published to npm for other apps to work; re-running init replaces old absolute-path hooks.
<!-- /agency:ai -->
