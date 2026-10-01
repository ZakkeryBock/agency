# CLI

## What it does
<!-- agency:ai -->
Single entry point `bin/agency.js`. Lazy-imports each subcommand so hooks and the statusline start fast.
<!-- /agency:ai -->

## Notes

## Gotchas
<!-- agency:ai -->
bin/launch.cjs runs `npx -y agency-dev` cross-platform for the plugin. `init --plugin` skips MCP/hooks/skill.
<!-- /agency:ai -->
