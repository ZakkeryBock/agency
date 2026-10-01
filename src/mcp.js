// MCP server: how AIs read and edit what the user sees. Tool count kept low on purpose,
// every tool definition costs context tokens on every request.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as S from './store.js';

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

export async function runMcp() {
  const root = S.findRoot();
  if (!root) { console.error('agency: no .agency/ found, run `agency init`'); process.exit(1); }
  const agent = process.env.AGENCY_AGENT || 'mcp-client';
  const server = new McpServer({ name: 'agency', version: '0.1.0' });

  const originFor = (decisionId) => {
    const d = decisionId && S.getDecision(root, decisionId);
    return { actor: d?.chosen_by === 'user' ? 'user' : 'ai', agent, decision: decisionId || undefined, at: new Date().toISOString() };
  };

  server.registerTool('agency_context', {
    description: 'Call FIRST before planning any non-trivial task. Returns a focused briefing: components the task touches, what they depend on / what relies on them, user notes, project rules, related decisions (incl. rejected options), recent changes.',
    inputSchema: { task: z.string().describe('What you are about to do, include file paths if known'), budget: z.number().optional().describe('Max tokens, default 4000') },
  }, async ({ task, budget }) => ok(S.context(root, task, budget).briefing));

  server.registerTool('agency_search', {
    description: 'Search wiki pages, components and decisions. mode "semantic" uses local Ollama embeddings if available.',
    inputSchema: { query: z.string(), mode: z.enum(['text', 'semantic']).optional() },
  }, async ({ query, mode }) => {
    if (mode === 'semantic') {
      try { return ok(await S.semanticSearch(root, query, 10)); } catch (e) { return fail(`semantic search unavailable (${e.message}); use mode text`); }
    }
    return ok(S.search(root, query, 10).map(({ score, ...r }) => r));
  });

  server.registerTool('agency_get', {
    description: 'No id: whole map (components+edges) plus coverage (unmapped files, stale components). With id: one component, its wiki page, deps and dependents.',
    inputSchema: { id: z.string().optional() },
  }, async ({ id }) => {
    const map = S.loadMap(root);
    if (!id) {
      const cov = S.coverage(root, map);
      const state = S.loadState(root);
      return ok({ components: map.components.map(({ origin, ...c }) => ({ ...c, by: origin?.actor })), edges: map.edges,
        unmapped: cov.unmapped.slice(0, 50), unmappedCount: cov.unmapped.length, deadGlobs: cov.dead, stale: Object.keys(state.stale) });
    }
    const c = map.components.find((x) => x.id === id);
    if (!c) return fail(`no component ${id}`);
    return ok({ ...c, dependsOn: map.edges.filter((e) => e.from === id), reliedOnBy: map.edges.filter((e) => e.to === id),
      page: S.readPage(root, S.componentPage(id))?.text || null });
  });

  const compSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('kebab-case'),
    name: z.string(),
    kind: z.enum(['service', 'module', 'ui', 'datastore', 'external', 'infra', 'tooling']),
    files: z.array(z.string()).describe('globs relative to repo root'),
    summary: z.string().describe('one sentence'),
  });
  const edgeSchema = z.object({ from: z.string(), to: z.string(), kind: z.enum(['calls', 'reads', 'writes', 'depends-on', 'renders', 'configures']), why: z.string() });

  server.registerTool('agency_update_map', {
    description: 'Batch edit the map the user sees. Pass decision id if the change comes from a decision. New components get a wiki stub; fill it with agency_write_page.',
    inputSchema: {
      upsert: z.array(compSchema).optional(), remove: z.array(z.string()).optional(),
      link: z.array(edgeSchema).optional(), unlink: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      decision: z.string().optional(), reason: z.string().optional(),
    },
  }, async ({ upsert = [], remove = [], link = [], unlink = [], decision, reason }) => {
    const map = S.loadMap(root);
    for (const c of upsert) {
      const i = map.components.findIndex((x) => x.id === c.id);
      if (i >= 0) map.components[i] = { ...map.components[i], ...c };
      else {
        map.components.push({ ...c, origin: originFor(decision) });
        if (!S.readPage(root, S.componentPage(c.id))) S.writePage(root, S.componentPage(c.id), `# ${c.name}\n\n## What it does\n<!-- agency:ai -->\n${c.summary}\n<!-- /agency:ai -->\n\n## Notes\n`);
      }
    }
    map.components = map.components.filter((c) => !remove.includes(c.id));
    map.edges = map.edges.filter((e) => !remove.includes(e.from) && !remove.includes(e.to)
      && !unlink.some((u) => u.from === e.from && u.to === e.to)
      && !link.some((l) => l.from === e.from && l.to === e.to));
    const ids = new Set(map.components.map((c) => c.id));
    const bad = link.filter((l) => !ids.has(l.from) || !ids.has(l.to));
    if (bad.length) return fail(`unknown component in link: ${bad.map((b) => `${b.from}->${b.to}`).join(', ')}`);
    map.edges.push(...link);
    S.saveMap(root, map);
    // newly covered files are no longer unmapped
    const state = S.loadState(root);
    const covered = S.componentsForFiles(map, state.unmapped);
    const nowMapped = new Set([...covered.values()].flat());
    state.unmapped = state.unmapped.filter((f) => !nowMapped.has(f));
    S.saveState(root, state);
    S.appendEvent(root, { actor: 'ai', agent, kind: 'map', reason, decision, components: [...upsert.map((c) => c.id), ...remove] });
    return ok(`ok: ${map.components.length} components, ${map.edges.length} edges`);
  });

  server.registerTool('agency_read_page', {
    description: 'Read a wiki page by path (e.g. "components/auth.md", "conventions.md").',
    inputSchema: { path: z.string() },
  }, async ({ path }) => {
    const pg = S.readPage(root, path);
    return pg ? ok(pg.text) : fail(`no page ${path}`);
  });

  server.registerTool('agency_write_page', {
    description: 'Write a wiki page. Prefer `sections` ({heading: markdown}): only rewrites AI-owned blocks under those ## headings, user text is preserved. `content` replaces the whole page and is only allowed for new pages or with user_approved (user explicitly asked). Locked pages are refused.',
    inputSchema: {
      path: z.string(), sections: z.record(z.string(), z.string()).optional(), content: z.string().optional(),
      user_approved: z.boolean().optional(), reason: z.string().optional(),
    },
  }, async ({ path, sections, content, user_approved, reason }) => {
    const pg = S.readPage(root, path);
    if (pg?.props.locked && !user_approved) return fail('page is locked by the user');
    let text;
    if (content !== undefined) {
      if (pg && !user_approved) return fail('page exists: use sections, or user_approved if the user asked for a rewrite');
      text = content;
    } else if (sections) {
      text = S.writeAiSections(pg?.text || `# ${path.replace(/\.md$/, '').split('/').pop()}\n`, sections);
    } else return fail('pass sections or content');
    const rel = S.writePage(root, path, text);
    S.appendEvent(root, { actor: 'ai', agent, kind: 'wiki', page: rel, reason });
    return ok(`ok: ${rel}`);
  });

  server.registerTool('agency_refresh', {
    description: 'Keep the user\'s map current after code edits, cheaply. For each stale component: pass only what changed (summary and/or sections like "Gotchas"), or just the id if nothing user-visible changed. Clients without edit hooks also pass the files they edited.',
    inputSchema: {
      updates: z.array(z.object({ id: z.string(), summary: z.string().optional(), sections: z.record(z.string(), z.string()).optional() })),
      files: z.array(z.string()).optional(), reason: z.string().optional(), decision: z.string().optional(),
    },
  }, async ({ updates, files, reason, decision }) => {
    if (files?.length) {
      const rel = files.map((f) => S.relFile(root, f));
      const hit = S.markStale(root, rel);
      S.appendEvent(root, { actor: 'ai', agent, kind: 'edit', files: rel, components: hit.components, reason, decision });
    }
    const map = S.loadMap(root);
    const state = S.loadState(root);
    for (const u of updates) {
      const c = map.components.find((x) => x.id === u.id);
      if (!c) continue;
      if (u.summary) c.summary = u.summary;
      if (u.sections) {
        const pg = S.readPage(root, S.componentPage(u.id));
        S.writePage(root, S.componentPage(u.id), S.writeAiSections(pg?.text || `# ${c.name}\n`, u.sections));
      }
      delete state.stale[u.id];
    }
    S.saveMap(root, map);
    S.saveState(root, state);
    if (reason || decision) S.appendEvent(root, { actor: 'ai', agent, kind: 'refresh', components: updates.map((u) => u.id), reason, decision });
    const left = Object.keys(state.stale);
    return ok(left.length ? `ok, still stale: ${left.join(', ')}` : 'ok, map current');
  });

  const option = z.object({
    name: z.string(),
    what_it_is: z.string().min(40).describe('Plain-language explanation for someone who has never used it'),
    how_it_fits_here: z.string().min(40).describe('Which components change / get added in THIS codebase, rough size of change'),
    pros: z.array(z.string()).min(1), cons: z.array(z.string()).min(1),
    effort: z.enum(['S', 'M', 'L']),
    reversibility: z.enum(['easy', 'moderate', 'hard']), reversibility_why: z.string(),
    lock_in: z.enum(['none', 'low', 'high']),
    cost: z.string().describe('free / self-hosted / $ estimate'),
    adds_components: z.array(z.string()).optional(), changes_components: z.array(z.string()).optional(),
    links: z.object({ docs: z.string().url().optional(), repo: z.string().url().optional(), license: z.string().optional(), maturity: z.string().optional() }).optional()
      .describe('Required when the option is a tool/library/service. Verify URLs if you can fetch.'),
  });

  server.registerTool('agency_propose_decision', {
    description: 'Open a fork for the user when work hits a major choice: new dependency or service, new component, schema/storage change, auth/security, public API change, or anything hard to reverse. Every option must be fully explained. Then tell the user briefly in chat that the decision is in the Decisions tab and wait (agency_get_decision).',
    inputSchema: {
      question: z.string(), context: z.string().min(40).describe('What is needed and why now, referencing components'),
      affects: z.array(z.string()).describe('component ids'),
      options: z.array(option).min(2).max(5),
      recommendation: z.object({ option: z.string(), why: z.string().min(30).describe('Tied to this project, not generic'), would_change_mind_if: z.string() }),
    },
  }, async (input) => {
    if (!input.options.some((o) => o.name === input.recommendation.option)) return fail('recommendation.option must match an option name');
    const d = { id: S.nextDecisionId(root), ...input, status: 'open', chosen: null, chosen_by: null, created: new Date().toISOString(), agent };
    S.saveDecision(root, d);
    S.appendEvent(root, { actor: 'ai', agent, kind: 'decision-open', decision: d.id, components: input.affects, reason: input.question });
    // Two-way link: show the pick in the client terminal (MCP elicitation) AND watch for a GUI answer; first one wins.
    if (server.server.getClientCapabilities()?.elicitation) {
      const ac = new AbortController();
      let viaGui = null;
      const poll = setInterval(() => {
        const cur = S.getDecision(root, d.id);
        if (cur?.status === 'chosen') { viaGui = cur; ac.abort(); }
      }, 500);
      const rec = input.recommendation.option;
      try {
        const r = await server.server.elicitInput({
          message: `${d.id}: ${input.question}\n\n${input.context}\n\nRecommended: ${rec}. ${input.recommendation.why}\n(You can also answer in the Agency GUI.)`,
          requestedSchema: { type: 'object', required: ['choice'], properties: { choice: {
            type: 'string', title: 'Pick one',
            oneOf: input.options.map((o) => ({ const: o.name, title: `${o.name}${o.name === rec ? ' (Recommended)' : ''}: ${o.what_it_is} [effort ${o.effort}, ${o.reversibility} to reverse]` })),
          } } },
        }, { signal: ac.signal, timeout: 10 * 60 * 1000 });
        if (r.action === 'accept' && input.options.some((o) => o.name === r.content?.choice)) {
          const cur = S.getDecision(root, d.id);
          if (cur.status !== 'chosen') {
            Object.assign(cur, { status: 'chosen', chosen: r.content.choice, chosen_by: 'user', decided: new Date().toISOString() });
            S.saveDecision(root, cur);
            S.appendEvent(root, { actor: 'user', kind: 'decision-chosen', decision: d.id, components: d.affects, reason: cur.chosen, via: 'terminal' });
          }
          return ok(`${d.id} chosen by user in terminal: ${r.content.choice}. Build with it.`);
        }
      } catch { /* aborted by GUI answer, timeout, or client without form support: fall through */ }
      finally { clearInterval(poll); }
      const cur = viaGui || S.getDecision(root, d.id);
      if (cur.status === 'chosen') return ok(`${d.id} chosen by user in the GUI: ${cur.chosen}. Build with it.`);
      return ok(`${d.id} left open (user dismissed the prompt). It is still in Agency → Decisions; check agency_get_decision later and don't build the forked part yet.`);
    }
    return ok(`${d.id} opened (also visible in Agency → Decisions). NOW ask the user with AskUserQuestion: one option per option name (recommended first, label + " (Recommended)"; description = what it is, main pro/con, effort, reversibility). Then call agency_get_decision(id, choose=<exact option name>). No AskUserQuestion available: tell the user in one line and wait.`);
  });

  server.registerTool('agency_get_decision', {
    description: 'Read a decision and its status. If the user answered in chat instead of the GUI, pass choose to record their pick.',
    inputSchema: { id: z.string(), choose: z.string().optional().describe('option name the user picked in chat') },
  }, async ({ id, choose }) => {
    const d = S.getDecision(root, id);
    if (!d) return fail(`no decision ${id}`);
    if (choose) {
      if (!d.options.some((o) => o.name === choose)) return fail(`no option "${choose}"`);
      Object.assign(d, { status: 'chosen', chosen: choose, chosen_by: 'user', decided: new Date().toISOString() });
      S.saveDecision(root, d);
      S.appendEvent(root, { actor: 'user', kind: 'decision-chosen', decision: id, components: d.affects, reason: choose, via: 'chat' });
    }
    return ok({ id: d.id, status: d.status, chosen: d.chosen, chosen_by: d.chosen_by, note: d.note });
  });

  server.registerTool('agency_record_decision', {
    description: 'Record a minor choice you made yourself (below the fork threshold) so the user can see it in the timeline.',
    inputSchema: { question: z.string(), chosen: z.string(), why: z.string(), affects: z.array(z.string()) },
  }, async ({ question, chosen, why, affects }) => {
    const d = { id: S.nextDecisionId(root), question, context: why, affects, options: [{ name: chosen }], recommendation: { option: chosen, why },
      status: 'chosen', chosen, chosen_by: 'ai', minor: true, created: new Date().toISOString(), agent };
    S.saveDecision(root, d);
    S.appendEvent(root, { actor: 'ai', agent, kind: 'decision-ai', decision: d.id, components: affects, reason: question });
    return ok(`${d.id} recorded`);
  });

  await server.connect(new StdioServerTransport());
}
