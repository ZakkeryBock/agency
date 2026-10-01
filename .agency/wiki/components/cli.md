# CLI

## What it does
<!-- agency:ai -->
Single entry point `bin/agency.js`. Lazy-imports each subcommand so hooks and the statusline start fast.
<!-- /agency:ai -->

## Notes

## Gotchas
<!-- agency:ai -->
Hook handlers are wrapped in try/catch: a hook must never break the user's Claude Code session.
<!-- /agency:ai -->
