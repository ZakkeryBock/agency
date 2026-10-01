// Claude Code hook handlers + statusline. Deterministic work happens here so the AI spends no tokens on it.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as S from './store.js';
import { isRule } from './md.js';

const readStdin = () => { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; } };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function touchSession(state, sid, tool) {
  if (!sid) return;
  const s = state.sessions[sid] || { calls: 0 };
  if (tool) { s.calls++; s.lastTool = tool; }
  s.last = Date.now();
  state.sessions[sid] = s;
  for (const [k, v] of Object.entries(state.sessions)) if (Date.now() - v.last > 2 * 864e5) delete state.sessions[k];
}

export function sessionStart() {
  const input = readStdin();
  const root = S.findRoot(input.cwd);
  if (!root) return;
  const state = S.loadState(root);
  touchSession(state, input.session_id);
  S.saveState(root, state);
  const pages = S.listPages(root);
  const rules = pages.filter(isRule).map((pg) => pg.path);
  const open = S.listDecisions(root).filter((d) => d.status === 'open').map((d) => `${d.id} ${d.question}`);
  const stale = Object.keys(state.stale);
  const lines = [
    'Agency is active in this repo: shared project map + wiki the user reads (.agency/). Use the agency skill.',
    `Map: ${S.mapDigest(root) || '(empty — run the agency skill "map" flow if user asks)'}`,
    rules.length && `Rule pages (always respect): ${rules.join(', ')}`,
    open.length && `Open decisions waiting on user: ${open.join('; ')}`,
    stale.length && `Stale components: ${stale.join(', ')}`,
    'Before non-trivial work: agency_context(task). Major fork: agency_propose_decision. After edits: agency_refresh with minimal deltas.',
  ].filter(Boolean);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
}

export function postTool() {
  const input = readStdin();
  const root = S.findRoot(input.cwd);
  if (!root) return;
  const tool = input.tool_name || '';
  const state = S.loadState(root);
  if (tool.startsWith('mcp__agency__')) {
    touchSession(state, input.session_id, tool.replace('mcp__agency__', ''));
    S.saveState(root, state);
    return;
  }
  if (!EDIT_TOOLS.has(tool)) return;
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!file) return;
  const rel = S.relFile(root, file);
  if (rel.startsWith('..')) return;
  if (rel.startsWith(S.DIR + '/')) {
    // AI wrote agency files directly (no MCP): still a visible event
    if (rel.startsWith(S.DIR + '/wiki/')) S.appendEvent(root, { actor: 'ai', agent: 'claude-code', session: input.session_id, kind: 'wiki', page: rel.slice(S.DIR.length + 6) });
    return;
  }
  touchSession(state, input.session_id);
  S.saveState(root, state);
  const hit = S.markStale(root, [rel]);
  S.appendEvent(root, { actor: 'ai', agent: 'claude-code', session: input.session_id, kind: 'edit', tool, files: [rel], components: hit.components });
}

export function stop() {
  const input = readStdin();
  if (input.stop_hook_active) return; // one nudge per turn, never loop
  const root = S.findRoot(input.cwd);
  if (!root) return;
  const state = S.loadState(root);
  const stale = Object.entries(state.stale);
  const unmapped = state.unmapped;
  if (!stale.length && !unmapped.length) return;
  const parts = [];
  if (stale.length) parts.push(`stale: ${stale.map(([id, f]) => `${id} (${f.slice(0, 3).join(', ')}${f.length > 3 ? ', …' : ''})`).join('; ')}`);
  if (unmapped.length) parts.push(`unmapped new files: ${unmapped.slice(0, 8).join(', ')}${unmapped.length > 8 ? ` +${unmapped.length - 8}` : ''}`);
  const reason = `Agency ${parts.join(' | ')}. Update cheaply: one agency_refresh call; ids only if nothing user-visible changed, else only changed summary/sections (≤3 lines each). Unmapped files: add globs via agency_update_map. Don't re-read files you already saw. Then stop, no recap.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

// git post-commit: attributes commit, catches edits no AI hook saw (user edits, Bash sed, other tools).
export function postCommit() {
  const root = S.findRoot();
  if (!root) return;
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  const [sha, ...msg] = git('log', '-1', '--format=%H%n%B').split('\n');
  const body = msg.join('\n');
  const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD').split('\n').filter((f) => f && !f.startsWith(S.DIR + '/'));
  const aiTrailer = /co-authored-by:.*(claude|copilot|cursor|codex|aider|gemini|devin|openai|anthropic)/i.test(body);
  const state = S.loadState(root);
  const since = state.lastCommitAt || 0;
  const aiFiles = new Set(S.readLog(root, 2000).filter((e) => e.kind === 'edit' && e.actor === 'ai' && Date.parse(e.at) > since).flatMap((e) => e.files || []));
  const userFiles = files.filter((f) => !aiFiles.has(f));
  const hit = S.markStale(root, userFiles, { lastCommitAt: Date.now() });
  const comps = [...S.componentsForFiles(S.loadMap(root), files).keys()];
  S.appendEvent(root, { actor: aiTrailer ? 'ai' : 'user', kind: 'commit', commit: sha.slice(0, 10), reason: body.split('\n')[0], files, components: comps,
    ...(userFiles.length && { userFiles, inferred: true }) });
  if (hit.components.length) console.error(`agency: marked stale ${hit.components.join(', ')}`);
}

export function statusline() {
  const input = readStdin();
  const root = S.findRoot(input.workspace?.current_dir || input.cwd);
  if (!root) return;
  const map = S.loadMap(root);
  const state = S.loadState(root);
  const open = S.listDecisions(root).filter((d) => d.status === 'open').length;
  const sess = state.sessions[input.session_id];
  const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
  const parts = [`${map.components.length} comps`];
  const stale = Object.keys(state.stale).length + (state.unmapped.length ? 1 : 0);
  if (stale) parts.push(c('38;5;179', `${Object.keys(state.stale).length} stale${state.unmapped.length ? ` +${state.unmapped.length} new` : ''}`));
  if (open) parts.push(c('38;5;175', `${open} decision${open > 1 ? 's' : ''}`));
  parts.push(sess?.calls ? c('38;5;114', `AI used ${sess.calls}×${sess.lastTool ? ` (${sess.lastTool})` : ''}`) : c('2', 'idle'));
  process.stdout.write(`${c('38;5;80', '[AGENCY]')} ${parts.join(' · ')}`);
}
