// `agency init`: scaffold .agency/ and wire Claude Code (MCP, hooks, skill) + other agents (AGENTS.md) + git.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as S from './store.js';

const PKG = path.resolve(fileURLToPath(import.meta.url), '../..');
export const BIN = path.join(PKG, 'bin', 'agency.js').split(path.sep).join('/');
const cmd = (sub) => `node "${BIN}" ${sub}`;

const TEMPLATES = {
  'component.md': '# {{title}}\n\n## What it does\n\n## Why it exists\n\n## Gotchas\n\n## Notes\n',
  'convention.md': '---\ntags: [convention]\n---\n# {{title}}\n\n<!-- A rule every AI session must follow. -->\n\n- \n',
  'feature-spec.md': '---\ntags: [spec]\nstatus: draft\n---\n# {{title}}\n\n## Goal\n\n## Components involved\n[[ ]]\n\n## Open questions\n- [ ] \n',
  'postmortem.md': '---\ntags: [postmortem]\n---\n# {{title}}\n\n## What broke\n\n## Root cause\n\n## Fix\n\n## Never again\n',
};

const START = {
  'index.md': `# Project wiki

Your notes here are the AI's memory. Anything outside a tinted **AI block** is yours: the AI reads it but won't change it unless you ask.

- Link pages with \`[[page name]]\`, embed a component with \`![[component-id]]\` or a decision with \`![[D-0001]]\`.
- Tag a page \`convention\` or \`rule\` and every AI session will follow it.
- Type \`/\` in the editor for blocks, \`Ctrl+K\` to jump anywhere.
`,
  'conventions.md': '---\ntags: [convention]\n---\n# Conventions\n\n<!-- Rules every AI session must follow in this project. Add bullets below. -->\n\n- \n',
};

function mergeJSON(file, fn) {
  const data = S.readJSON(file, {});
  fn(data);
  S.writeJSON(file, data);
}

export function init(root = process.cwd()) {
  const A = (...x) => path.join(root, S.DIR, ...x);
  const created = [];
  const put = (file, text) => { if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); created.push(path.relative(root, file)); } };

  put(A('map.json'), JSON.stringify({ components: [], edges: [] }, null, 2) + '\n');
  put(A('log.jsonl'), '');
  put(A('.gitignore'), '.state.json\n.cache/\n*.tmp\n');
  fs.mkdirSync(A('decisions'), { recursive: true });
  for (const [f, t] of Object.entries(START)) put(A('wiki', f), t);
  for (const [f, t] of Object.entries(TEMPLATES)) put(A('wiki', '_templates', f), t);
  S.appendEvent(root, { actor: 'user', kind: 'init', reason: 'Agency installed; everything before this is pre-agency' });

  // MCP server for Claude Code (project scope)
  mergeJSON(path.join(root, '.mcp.json'), (d) => {
    d.mcpServers = d.mcpServers || {};
    d.mcpServers.agency = { command: 'node', args: [BIN, 'mcp'], env: { AGENCY_AGENT: 'claude-code' } };
  });

  // Hooks (project settings, merged, idempotent)
  mergeJSON(path.join(root, '.claude', 'settings.json'), (d) => {
    d.hooks = d.hooks || {};
    const add = (event, sub, matcher) => {
      const list = (d.hooks[event] = d.hooks[event] || []);
      const c = cmd(`hook ${sub}`);
      if (list.some((g) => g.hooks?.some((h) => h.command?.includes('agency.js" hook')))) return;
      list.push({ ...(matcher && { matcher }), hooks: [{ type: 'command', command: c, timeout: 10 }] });
    };
    add('SessionStart', 'session-start');
    add('PostToolUse', 'post-tool', 'Edit|Write|MultiEdit|NotebookEdit|mcp__agency__.*');
    add('Stop', 'stop');
    d.enabledMcpjsonServers = [...new Set([...(d.enabledMcpjsonServers || []), 'agency'])];
  });

  // Skill
  const skillDst = path.join(root, '.claude', 'skills', 'agency', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillDst), { recursive: true });
  fs.copyFileSync(path.join(PKG, 'skills', 'agency', 'SKILL.md'), skillDst);

  // Other agents (Cursor, Codex, ...) read AGENTS.md
  const agents = path.join(root, 'AGENTS.md');
  const marker = '<!-- agency -->';
  const prev = fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : '';
  if (!prev.includes(marker)) {
    const skill = fs.readFileSync(path.join(PKG, 'skills', 'agency', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
    fs.writeFileSync(agents, `${prev}${prev ? '\n\n' : ''}${marker}\n${skill.trim()}\n${marker}\n`);
  }

  // git post-commit: attribute commits + catch edits no hook saw
  const gitHooks = path.join(root, '.git', 'hooks');
  if (fs.existsSync(gitHooks)) {
    const hook = path.join(gitHooks, 'post-commit');
    const line = `${cmd('hook post-commit')} || true`;
    const cur = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : '#!/bin/sh\n';
    if (!cur.includes('agency.js" hook post-commit')) fs.writeFileSync(hook, cur.replace(/\s*$/, '\n') + line + '\n', { mode: 0o755 });
  }

  return created;
}

// Statusline: set it if the user has none; otherwise tell them what to add.
export function installStatusline() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(dir, 'settings.json');
  const d = S.readJSON(file, {});
  const c = cmd('statusline');
  if (!d.statusLine) {
    d.statusLine = { type: 'command', command: c };
    S.writeJSON(file, d);
    return `statusline set in ${file}`;
  }
  if (d.statusLine.command?.includes(BIN)) return 'statusline already includes agency';
  return `You already have a statusline (${d.statusLine.command}).\nAdd this command to it; it reads the same stdin JSON and prints the [AGENCY] badge:\n  ${c}`;
}
