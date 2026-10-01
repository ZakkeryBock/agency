// One runnable check: init a temp repo, drive hooks + MCP like Claude Code would, assert the user-visible state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as S from '../src/store.js';
import { init, BIN } from '../src/init.js';
import { parseFrontmatter, stringifyFrontmatter, takeOwnership, segments } from '../src/md.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-'));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
w('src/auth/token.js', 'export const sign = () => 1;\n');
w('src/api/routes.js', 'import "../auth/token.js";\n');
w('README.md', '# demo\n');
execFileSync('git', ['init', '-q'], { cwd: root });

// init wires everything
init(root);
for (const f of ['.agency/map.json', '.agency/wiki/index.md', '.mcp.json', '.claude/settings.json', '.claude/skills/agency/SKILL.md', 'AGENTS.md', '.git/hooks/post-commit'])
  assert.ok(fs.existsSync(path.join(root, f)), `init created ${f}`);
init(root); // idempotent
assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).hooks.Stop.length, 1, 'hooks not duplicated');

// frontmatter + ownership helpers
const fm = stringifyFrontmatter({ tags: ['a', 'b'], locked: true }, 'body\n');
assert.deepEqual(parseFrontmatter(fm).props, { tags: ['a', 'b'], locked: true });
const owned = 'x\n<!-- agency:ai -->\nai1\n<!-- /agency:ai -->\ny\n<!-- agency:ai -->\nai2\n<!-- /agency:ai -->\n';
assert.equal(segments(owned).filter((s) => s.ai).length, 2);
assert.ok(!takeOwnership(owned, 0).includes('ai1\n<!-- /agency'), 'first block markers removed');
assert.ok(takeOwnership(owned, 0).includes('<!-- agency:ai -->\nai2'), 'second block kept');

// MCP: map the project like an AI would
const client = new Client({ name: 'selfcheck', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [BIN, 'mcp'], cwd: root, stderr: 'pipe' }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { err: r.isError, text: r.content[0].text };
};
const tools = (await client.listTools()).tools.map((t) => t.name);
assert.ok(tools.includes('agency_context') && tools.includes('agency_propose_decision'), 'tools listed');

let r = await call('agency_update_map', {
  upsert: [
    { id: 'auth', name: 'Auth', kind: 'module', files: ['src/auth/**'], summary: 'Signs tokens.' },
    { id: 'api', name: 'API', kind: 'service', files: ['src/api/**'], summary: 'HTTP routes.' },
    { id: 'docs', name: 'Docs', kind: 'tooling', files: ['*.md'], summary: 'Readme.' },
  ],
  link: [{ from: 'api', to: 'auth', kind: 'calls', why: 'every request checks a token' }],
});
assert.ok(!r.err, r.text);
assert.equal(S.coverage(root).unmapped.filter((f) => !f.startsWith('.claude') && f !== '.mcp.json').length, 0, 'all source files mapped');

// user note in the component page must survive AI writes and reach the briefing
const pg = S.readPage(root, 'components/auth.md');
S.writePage(root, 'components/auth.md', pg.text + 'Never use sessions here.\n');
r = await call('agency_write_page', { path: 'components/auth.md', sections: { 'What it does': 'Signs and checks JWTs.', Gotchas: 'Clock skew 30s.' } });
assert.ok(!r.err, r.text);
const after = S.readPage(root, 'components/auth.md').text;
assert.ok(after.includes('Never use sessions here.') && after.includes('Signs and checks JWTs.'), 'user text kept, AI text written');
assert.ok((await call('agency_write_page', { path: 'components/auth.md', content: 'nuke' })).err, 'full rewrite refused without approval');

w('.agency/wiki/conventions.md', '---\ntags: [convention]\n---\n# Conventions\n\nAlways return {error, code}.\n');
r = await call('agency_context', { task: 'change token signing in auth' });
assert.match(r.text, /Never use sessions here/, 'user note in briefing');
assert.match(r.text, /Always return \{error, code\}/, 'convention in briefing');
assert.match(r.text, /relied on by: api/, 'dependents in briefing');

// decision: weak options are rejected by schema, full ones accepted
assert.ok((await call('agency_propose_decision', { question: 'q', context: 'short', affects: [], options: [], recommendation: { option: 'x', why: 'y', would_change_mind_if: 'z' } })).err);
const opt = (name) => ({ name, what_it_is: `${name} is a thing that does a thing for a long enough explanation.`, how_it_fits_here: 'Changes auth and adds a store component; about 200 lines in src/auth.',
  pros: ['p'], cons: ['c'], effort: 'M', reversibility: 'moderate', reversibility_why: 'data migration', lock_in: 'low', cost: 'free', links: { docs: 'https://example.com/docs' } });
r = await call('agency_propose_decision', { question: 'Where to store refresh tokens?', context: 'Auth needs refresh tokens so users stay logged in across restarts.', affects: ['auth'],
  options: [opt('SQLite'), opt('Redis')], recommendation: { option: 'SQLite', why: 'Already local-first, no new service to run.', would_change_mind_if: 'multiple servers' } });
assert.ok(!r.err, r.text);
const id = r.text.slice(0, 6);
r = await call('agency_get_decision', { id, choose: 'SQLite' });
assert.match(r.text, /"chosen_by":"user"/);
await call('agency_update_map', { upsert: [{ id: 'token-store', name: 'Token store', kind: 'datastore', files: ['src/store/**'], summary: 'SQLite refresh tokens.' }], decision: id });
assert.equal(S.loadMap(root).components.find((c) => c.id === 'token-store').origin.actor, 'user', 'component from user decision is attributed to user');

// hooks: edit marks stale, stop nudges once, refresh clears
const hook = (name, input) => execFileSync('node', [BIN, 'hook', name], { cwd: root, input: JSON.stringify({ cwd: root, session_id: 's1', ...input }), encoding: 'utf8' });
hook('post-tool', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/auth/token.js') } });
assert.deepEqual(Object.keys(S.loadState(root).stale), ['auth']);
const stop = JSON.parse(hook('stop', {}));
assert.equal(stop.decision, 'block');
assert.match(stop.reason, /auth/);
assert.equal(hook('stop', { stop_hook_active: true }), '', 'no loop');
hook('post-tool', { tool_name: 'mcp__agency__agency_refresh' });
r = await call('agency_refresh', { updates: [{ id: 'auth' }] });
assert.match(r.text, /map current/);
assert.equal(hook('stop', {}), '', 'nothing stale, no nudge');
const badge = execFileSync('node', [BIN, 'statusline'], { input: JSON.stringify({ session_id: 's1', workspace: { current_dir: root } }), encoding: 'utf8' });
assert.match(badge, /\[AGENCY\].*4 comps.*AI used 1×/);
const sess = JSON.parse(hook('session-start', {})).hookSpecificOutput.additionalContext;
assert.match(sess, /api→auth/);

// search
assert.equal(S.search(root, 'jwt')[0].id, 'auth');

await client.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('selfcheck ok');
