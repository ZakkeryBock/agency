# Agency — Project Plan

Open-source, local-first tool that gives a developer cognitive agency over a codebase that AI is helping build.
Three parts: **a visual map + wiki (GUI)**, **tools that let AIs read/write what the user sees (MCP)**, and **skills that make AIs map projects and explain decisions well**.

---

## 1. Core idea in one picture

```
 user's repo
 ├── src/...                      <- their code
 └── .agency/                     <- everything Agency knows, plain files, committed to git
     ├── map.json                 <- components + edges
     ├── wiki/                    <- Obsidian-compatible vault
     │   ├── components/<id>.md   <- one page per component (what it does, who relies on it)
     │   └── <anything>.md        <- free pages: notes, conventions, glossary, ideas, roadmap
     ├── decisions/<id>.md        <- forks: options, explanation, links, who chose
     └── log.jsonl                <- append-only event log: every change, actor = user | ai

        ▲ read/write                         ▲ read/write
        │                                    │
  agency serve (local GUI)            agency mcp (MCP server)
  http://127.0.0.1:4141               used by Claude Code, Cursor, Codex, etc.
  Map | Wiki | Decisions | Timeline
```

Two users, one source of truth: the **human** browses and edits through the GUI, the **AI** reads and writes through MCP tools. Both see the same files, so the user's notes become the AI's memory and the AI's understanding becomes the user's docs.

Key choice: **state is plain files in the repo.** No database, no cloud.
- Diffable and reviewable in git like any other change.
- Any AI can edit it even without the MCP server (plain file tools work).
- "Map at any point in history" is free: `git show <sha>:.agency/map.json`.
- Ceiling: thousands of components or very large logs. Upgrade path: SQLite index built from the same files.

---

## 2. Components

### 2.1 CLI (`agency`)
| Command | Does |
|---|---|
| `agency init` | Create `.agency/`, install hooks (Claude Code + git), register MCP server, drop skill files and an `AGENTS.md` snippet. |
| `agency map` | Ask the connected AI (via skill) to build/refresh the map. Also runs a deterministic check (see 2.4). |
| `agency serve` | Start local GUI on `127.0.0.1` only, open browser. Watches `.agency/` and live-reloads. |
| `agency mcp` | Run the MCP server (stdio). Normally launched by the AI client, not the user. |
| `agency check` | Validate files: unmapped source files, dead globs, broken links, decisions missing required fields. CI-friendly exit code. |

### 2.2 Data model

**Component** (`map.json`)
```json
{
  "id": "auth",
  "name": "Authentication",
  "kind": "service | module | ui | datastore | external | infra",
  "files": ["src/auth/**", "src/middleware/session.ts"],
  "summary": "Issues and validates session tokens.",
  "origin": { "actor": "ai", "agent": "claude-code", "decision": "D-0003", "at": "2026-10-01T12:00:00Z" }
}
```
**Edge**: `{ "from": "api", "to": "auth", "kind": "calls | reads | writes | depends-on", "why": "every request validates token" }`

**Origin / provenance** — answers "why does this exist?":
- `actor: "user"` — user made it or chose it in a decision.
- `actor: "ai"` — AI added it without an explicit user decision.
- `actor: "pre-agency"` — existed before install (unknown cause, said honestly).
- `decision: "D-xxxx"` — link to the fork that produced it, if any.

**Component wiki page** (`wiki/components/auth.md`): frontmatter (id, files, origin, tags) + sections the skill always fills:
What it does · Why it exists · Relies on · Relied on by · Key files · Gotchas · History (auto-appended from log).

**Free page** (`wiki/*.md`): any markdown the user or AI wants — conventions, "how we do errors", glossary, product goals, meeting notes. Frontmatter properties are optional and user-defined (`tags`, `status`, `owner`, anything).

**Ownership inside a page** — so AI never clobbers the user's writing:
```markdown
## What it does
<!-- agency:ai -->            <- AI may rewrite this block freely
Issues and validates session tokens...
<!-- /agency:ai -->

## My notes                   <- everything outside ai blocks is user-owned:
Don't add OAuth until v2.        AI reads it, but only edits it when asked
```
Page-level `locked: true` in frontmatter = AI read-only.

**Event** (`log.jsonl`, one line each):
```json
{"at":"...","actor":"ai","agent":"claude-code","session":"...","kind":"edit","files":["src/auth/token.ts"],"components":["auth"],"reason":"add refresh tokens","decision":"D-0003","commit":null}
```

### 2.3 GUI tabs
1. **Map** — interactive graph of components. Click node: side panel with summary, origin badge (user / AI / pre-agency), link to wiki page. Click edge: the `why`. Filters: by actor ("show me everything AI added on its own"), by decision. Slider/commit picker to view map at past commits; diff mode highlights added/removed/changed components since a commit.
2. **Wiki** — a lite Notion/Obsidian (details in §2.9). User edits in GUI; edits logged as `actor: user`.
3. **Decisions** — open forks waiting on the user (top), past decisions (below). Option cards (see §3). User picks in GUI, choice is written to the decision file, AI picks it up.
4. **Timeline** — the log, grouped by session/commit. Each entry links to the components it touched and the decision behind it. Highlights AI edits with no linked decision.

### 2.4 Mapping — how the map gets built
Two layers, because "main components" is a judgment call but edges should be facts:
- **AI layer (skill + MCP):** AI reads the repo, groups files into components, writes summaries and wiki pages. This is what makes the map human-meaningful.
- **Deterministic layer (`agency check`):** every source file must match exactly one component glob; flags unmapped/orphaned files. Later: tree-sitter import scan (JS/TS/Python first) to verify AI-declared edges and flag missing ones.

Incremental updates: after each edit, the hook resolves touched files to components via globs, marks them `stale`. At end of turn (Claude Code `Stop` hook) or on commit, AI is prompted to refresh only stale wiki pages. Full remap only on demand.

### 2.5 Provenance capture — "AI or user?"
| Source | How | Actor |
|---|---|---|
| Claude Code edits | `PostToolUse` hook on Edit/Write → append event | ai |
| Other AI clients | MCP tool `agency_log_change` (skill tells them to call it) + `AGENTS.md` instruction | ai |
| User picked an option | Decision file `chosen_by: user` | user |
| Commits | git `post-commit` hook: attribute by `Co-Authored-By: Claude` / AI trailers, else user; reconcile with hook events | ai / user |
| Edits nobody logged | git diff vs last logged state | user (best guess, marked `inferred`) |

Honest limit: attribution is best-effort. Hooks give exact data for Claude Code; other tools depend on the AI following the skill. Unknowns are labelled, never guessed silently.

### 2.6 MCP server tools (what AIs use to edit what the user sees)
| Tool | Purpose |
|---|---|
| `agency_context` | **Main memory call.** Given a task description, returns a focused briefing (see §2.8). |
| `agency_search` | Full-text search over wiki + decisions, filter by tag/property/actor. |
| `agency_get_map` | Components + edges (optionally filtered) so the AI has architecture context before editing. |
| `agency_get_component` | One component + wiki page + dependents. "What breaks if I touch this?" |
| `agency_upsert_component` / `agency_remove_component` | Edit the map. |
| `agency_link` / `agency_unlink` | Edit edges with a `why`. |
| `agency_write_wiki` | Write/update a page. Only touches `agency:ai` blocks unless `user_approved: true`; refuses locked pages. |
| `agency_log_change` | Record an edit with reason + decision link (for clients without hooks). |
| `agency_propose_decision` | Open a fork for the user (§3). Returns decision id. |
| `agency_get_decision` | Poll status / read the user's choice. |
| `agency_record_decision` | Record a minor decision the AI made on its own (shows in Timeline as AI-chosen). |

MCP = works across Claude Code, Cursor, Codex, Windsurf, etc. without per-tool integrations.

### 2.7 Skills (shipped by `agency init`)
- `agency-map` — how to split a repo into components, naming rules, required wiki sections.
- `agency-decide` — the fork protocol (§3).
- `agency-maintain` — call `agency_context` before planning any non-trivial task, log changes, refresh stale pages, respect user-owned text.
- Same content mirrored into `AGENTS.md` for non-Claude agents.

### 2.8 Agency as AI memory (better than raw context)
Traditional context = whatever files the AI happens to open this session, forgotten next session. Agency gives a persistent, structured, user-curated memory the AI queries on demand.

**`agency_context(task)` returns a briefing, not a file dump:**
1. **Find entry points** — keyword search over component names, summaries, tags, wiki text; plus components whose file globs match paths mentioned in the task.
2. **Walk the graph** — 1–2 hops of edges from each entry point: what they rely on, what relies on them (blast radius).
3. **Attach what matters** — for each hit: summary, Gotchas, user-owned notes (highest priority, never trimmed), related decisions (incl. rejected options + why, so AI doesn't re-propose them), recent Timeline events.
4. **Global rules** — pages tagged `#convention` or `#rule` always included (coding style, "never use X", product goals).
5. **Budget** — trimmed to a token budget (default ~4k), ranked: user notes > conventions > decisions > summaries > history. Returns links so the AI can `agency_get_component` for more.

Example output:
```
Task touches: api, auth (entry) → db, email (deps) ← web-ui (dependent)
Rules: #convention "errors": always return {error, code}; never throw past route handlers
User note on auth: "Don't add OAuth until v2."
D-0003 chose JWT over sessions (user). Rejected: server sessions — needs Redis.
Gotcha: token refresh is racy on web-ui, see wiki/components/auth.md#gotchas
```

**Write-back loop:** after finishing, the AI updates `agency:ai` blocks with what it learned (new gotchas, changed deps). Next session, any AI starts from that.

Search v1 = plain in-memory text index (rebuild on file change; fine for thousands of pages). Ceiling: fuzzy/semantic queries miss. Upgrade path: optional local embeddings (e.g. via Ollama), opt-in, still local.

### 2.9 Wiki = lite Notion / Obsidian
Goal: pleasant enough that the user actually writes in it, because user notes are the most valuable AI memory.
- **Editor:** markdown source of truth with live preview (Obsidian-style, CodeMirror 6). Slash menu (`/`) for headings, checklist, callout, table, code, diagram, embed.
- **Links:** `[[page]]` and `[[component]]` wikilinks with autocomplete, backlinks panel on every page, unlinked-mention suggestions.
- **Embeds:** `![[auth]]` renders a live component card (summary + origin badge + deps); `![[D-0003]]` renders a decision card; Mermaid diagrams.
- **Organize:** folders, tags, user-defined frontmatter properties, a simple table view of pages filtered by tag/property (the "Notion database" lite).
- **Templates:** `wiki/_templates/*.md` (component, convention, feature spec, bug postmortem); user can add their own.
- **Search:** Ctrl+K quick switcher + full-text search (same index the AI uses).
- **Ownership visible:** AI blocks shown with a subtle tint + "AI-written" label; one click to "take ownership" (strip markers, becomes user text).
- **Obsidian compatible:** `.agency/wiki` opens as an Obsidian vault as-is — users who prefer Obsidian can use it instead of our editor.
- **Not in scope:** realtime multi-user collaboration, databases with relations/rollups, drag-and-drop block editing. Add later only if asked for.

---

## 3. Better decision making at forks

Problem: today AIs list 2–4 options in one line each, no real explanation, no links, no tie to the codebase.

### When it's a "fork" (must use the protocol)
New dependency or external service · new component · data schema / storage change · auth/security · public API change · anything expensive to reverse. Everything else: AI decides and calls `agency_record_decision` so it's still visible.

### Required shape of every option (enforced by MCP schema, rejected if missing)
```yaml
id: D-0007
question: How should we store user uploads?
context: What we need and why now, in 2–3 sentences, referencing map components.
affects: [api, storage]             # highlighted on the Map when viewing the decision
options:
  - name: S3-compatible object storage (MinIO locally)
    what_it_is: Plain-language explanation for someone who's never used it.
    how_it_fits_here: Which components change, what new component appears, rough diff size.
    pros: [...]
    cons: [...]
    effort: S | M | L
    reversibility: easy | moderate | hard   # + one line why
    lock_in: none | low | high
    cost: free / self-hosted / $ estimate
    links:
      docs: https://min.io/docs/...
      repo: https://github.com/minio/minio
      license: AGPL-3.0
      maturity: last release date, stars or adoption note (verified by fetch when online)
  - name: Local filesystem
    ...
recommendation:
  option: Local filesystem
  why: Tied to this project's constraints, not generic.
  would_change_mind_if: ...
status: open | chosen | superseded
chosen: null
chosen_by: null    # user | ai
```
GUI renders options as side-by-side cards, a comparison row for effort / reversibility / lock-in / cost, clickable links, and a map preview showing which components each option adds or changes.

### Flow
1. AI hits fork → `agency_propose_decision` → tells user in chat "Decision D-0007 open, see Decisions tab" (plus a short chat summary).
2. User picks in GUI (or answers in chat; AI records it).
3. Resulting components get `origin.decision = D-0007, actor = user`. The map now shows *why* it exists.
4. Later decisions can `supersede` old ones; history is kept.

---

## 4. Tech stack (minimal, local)
- **Node.js + TypeScript**, single npm package. Reason: Claude Code users already have Node; MCP TS SDK is first-class.
- **GUI:** static HTML/JS served by Node's built-in `http` module. **Cytoscape.js** for the graph, **marked** for markdown, **CodeMirror 6** for the editor, **Mermaid** for diagrams. One esbuild step to bundle the editor; no UI framework in v1. Upgrade to a framework only if the UI outgrows it.
- **File watching:** `fs.watch` + server-sent events for live reload.
- **Validation:** JSON Schema (one schema file per type), used by MCP server, `agency check`, and GUI.
- **Security:** bind to `127.0.0.1` only, random token in URL so other local sites can't hit the API, sanitize rendered markdown (wiki is AI-written and must be treated as untrusted HTML).
- **Deps budget:** MCP SDK, cytoscape, marked, CodeMirror 6, mermaid, a sanitizer (DOMPurify), a glob matcher, esbuild (dev). That's it.

---

## 5. Phases

**Phase 0 — Spec (small)**
JSON Schemas for component, edge, decision, event. Example `.agency/` folder for a sample repo. Done when: `agency check` validates the example.

**Phase 1 — See it, write in it**
`agency init`, `agency serve`, Map tab, Wiki tab with editor, wikilinks, backlinks, Ctrl+K search, templates. Done when: example repo renders, click node opens wiki, user can create/edit/link pages, live reload works.

**Phase 2 — AI maps it and remembers it**
MCP server (get/upsert/link/wiki/search/context tools), ownership blocks enforced, `agency-map` + `agency-maintain` skills, `agency map`. Glob coverage check. Done when: Claude Code maps a real mid-size repo with every file covered, and in a fresh session `agency_context` surfaces a user note that changes what the AI builds.

**Phase 2.5 — Wiki polish**
Slash menu, embeds (component/decision cards, Mermaid), properties + table view, AI-block tint + take-ownership. Done when: a user can run a small feature spec entirely in the wiki.

**Phase 3 — Who did what**
Claude Code hooks, git post-commit hook, `log.jsonl`, Timeline tab, origin badges + actor filter on Map, stale-page refresh. Done when: an AI session's edits show in Timeline and touched components update.

**Phase 4 — Decisions**
`agency_propose_decision` / `get` / `record`, `agency-decide` skill, Decisions tab with option cards and map preview, choose-in-GUI round trip. Done when: AI opens a fork, user picks in GUI, AI proceeds and the new component shows `actor: user, decision: D-xxxx`.

**Phase 5 — History + other agents**
Map at past commit + diff view. `AGENTS.md` + tested configs for Cursor and Codex. Tree-sitter edge verification for JS/TS/Python.

**Phase 6 — Open-source release**
README with a 2-minute demo GIF, MIT license, contributing guide, publish to npm.

---

## 6. Open questions for you
1. **Name:** `agency` is almost certainly taken on npm. Scoped (`@agency-dev/cli`) or a new name?
2. **Stack:** Node/TS proposed. Prefer Python?
3. **Commit `.agency/` to git?** Proposed yes (history for free, team shares it). Alternative: gitignored, personal only.
4. **Should the GUI let the user edit the map directly** (drag to add edges, rename components), or only wiki text + decisions in v1? Proposed: wiki + decisions only in v1.
5. **Granularity default:** ~5–20 components for a typical app. Allow nested components (sub-maps) later?
6. **Editor feel:** both built; toggle in the Wiki toolbar. Tracked as decision **D-0001** in the app.
7. **Semantic search:** text + graph default, Ollama embeddings built as opt-in. Tracked as decision **D-0002** in the app.

---

## 7. Build status (2026-10-01)
Built: phases 0–4 plus map history/diff, statusline badge, AGENTS.md for other agents. Stack deviation: plain ESM JavaScript instead of TypeScript (no compile step; only the GUI is bundled).
Not yet: tree-sitter edge verification, tested Cursor/Codex configs, npm publish (name `agency` is taken; package is `agency-dev` for now).
