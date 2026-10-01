---
name: agency
description: Project map, wiki and decision log shared with the user (.agency/). Use before planning non-trivial work (agency_context), when hitting a major choice (agency_propose_decision), when asked to map/remap the project, and after edits to keep the user's map current (agency_refresh).
---

# Agency

The user watches this project through Agency's map, wiki and decision log. It is also your long-term memory: user notes, rules, past decisions and gotchas live there. Read it before building; keep it true after.

## Before work
- Non-trivial task: call `agency_context(task)` first. Treat user notes and `convention`/`rule` pages as requirements. Don't re-propose options a decision already rejected unless something changed, and say what changed.
- Need more: `agency_get(id)`, `agency_search(query)`, `agency_read_page(path)`.

## Major fork: propose, don't pick
Fork = new dependency or external service, new component, schema/storage change, auth/security, public API change, anything costly to reverse.
1. `agency_propose_decision` with 2–4 real options. Each option: plain-language `what_it_is`, `how_it_fits_here` naming the actual components/files it changes, honest pros/cons, effort, reversibility (+why), lock-in, cost, and `links` (docs, repo, license, maturity) for any tool/library/service. Verify links if you can fetch.
2. Recommend one, tied to this project's constraints, plus what would change your mind.
3. `agency_propose_decision` itself shows the pick in the terminal (MCP elicitation) and watches the GUI; it blocks until the user answers in either place and returns the chosen option. If it returns "chosen", build with it. If it returns "NOW ask" (client has no elicitation), ask in the terminal right away with `AskUserQuestion` (when your client has it): header `D-000N`, question = the decision question, one option per decision option (label = exact option name, recommended first with " (Recommended)" appended to the label; description = what_it_is, key pro/con, effort, reversibility). Several open decisions = several questions in one call. Then pass the pick to `agency_get_decision(id, choose=<exact option name, without "(Recommended)">)`. The GUI Decisions tab shows the same decision and updates live; if the user answers there instead, `agency_get_decision` returns it. No `AskUserQuestion`: say in chat "Decision D-000N is waiting in Agency → Decisions: <question>. I recommend <X> because <reason>." and wait.
4. Build. Pass the decision id to `agency_update_map` / `agency_refresh` so the map shows the user chose it.
Small choices below the threshold: decide yourself and `agency_record_decision` (one call, no options needed).

## After edits: keep the map current, cheaply
Edit hooks already log which files and components changed, so you spend no tokens on bookkeeping. At the end of a turn you may be told which components are stale.
- One `agency_refresh` call per turn. Pass ids only if nothing the user would care about changed (refactors, typos, tests).
- If behavior, dependencies or gotchas changed: send only the changed `summary` and/or `sections` (e.g. `{"Gotchas": "..."}`), at most 3 lines each. Never rewrite a whole page to change one fact.
- New files outside every component: add globs to an existing component or create one via `agency_update_map` (with `link` edges + `why`).
- Don't re-read files to do this; use what you already know from the edit. No recap in chat afterwards.

## Wiki etiquette
- Only `<!-- agency:ai -->` blocks are yours. Write via `agency_write_page` with `sections`; it preserves user text. Full rewrites need `user_approved` (the user explicitly asked). Locked pages are read-only.
- Link with `[[page]]` / `[[component-id]]`; embed with `![[id]]`. Tag rules `convention`.

## Mapping a project (first run or "remap")
1. `agency_get` to see current state and unmapped files.
2. Read the repo structure (top-level dirs, entry points, package manifests, routes). Don't read every file.
3. Split into 5–20 components a newcomer would name: user-facing pieces, services, data stores, external APIs, tooling. Every source file must match exactly one component's globs.
4. One `agency_update_map` call with all components + edges (each edge with a `why`).
5. For each component, `agency_write_page` with sections: What it does, Why it exists, Key files, Gotchas. 2–5 lines each. Relationships are already on the map, don't duplicate them.
6. `agency_get` again; fix remaining unmapped files or dead globs.
