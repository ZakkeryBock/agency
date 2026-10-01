# Store

## What it does

<!-- agency:ai -->
All persistence is plain files under `.agency/` so it diffs in git and any AI can edit it without MCP.
`context()` builds the AI briefing: search hits → 1-hop graph walk → user notes, rules, decisions, recent events → trimmed to a token budget.
<!-- /agency:ai -->

## Notes

Keep search dependency-free. See [[conventions]].

## Gotchas

<!-- agency:ai -->
`.state.json` is local-only (gitignored): stale set and per-session usage.
Frontmatter parser is flat key/value on purpose; nested data lives in map.json.
<!-- /agency:ai -->
