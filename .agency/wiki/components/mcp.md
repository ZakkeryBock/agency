# MCP server

## What it does
<!-- agency:ai -->
Ten tools, kept few because every tool definition costs context tokens on every request.
`agency_write_page` only rewrites AI blocks unless the user approved a full rewrite.
`agency_propose_decision` enforces fully explained options via schema.
<!-- /agency:ai -->

## Notes

## Gotchas
<!-- agency:ai -->
propose_decision blocks: shows terminal form via MCP elicitation and polls decision file for a GUI answer, first wins (10 min cap). No elicitation support: returns text telling AI to use AskUserQuestion.
<!-- /agency:ai -->
