// All reads/writes of .agency/ go through here. Plain files, no database.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import picomatch from 'picomatch';
import { parseFrontmatter, stringifyFrontmatter, AI_OPEN, AI_CLOSE, userOwnedText, wikilinks, isRule } from './md.js';

export { parseFrontmatter, stringifyFrontmatter, userOwnedText, wikilinks };

export const DIR = '.agency';
const IGNORE = new Set(['node_modules', '.git', DIR, 'dist', 'build', '.next', 'out', 'coverage', '.venv', '__pycache__']);

export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, DIR))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export const p = (root, ...parts) => path.join(root, DIR, ...parts);
const posix = (s) => s.split(path.sep).join('/');

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ---------- map ----------
export const loadMap = (root) => readJSON(p(root, 'map.json'), { components: [], edges: [] });
export const saveMap = (root, map) => writeJSON(p(root, 'map.json'), map);

export function listSourceFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((f) => f && !f.startsWith(DIR + '/'));
  } catch {
    // ponytail: no .gitignore parsing outside git; IGNORE list covers the usual suspects
    return fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => posix(path.relative(root, path.join(d.parentPath ?? d.path, d.name))))
      .filter((f) => !f.split('/').some((seg) => IGNORE.has(seg)));
  }
}

const matcherCache = new Map();
function matcher(globs) {
  const key = globs.join('\0');
  if (!matcherCache.has(key)) matcherCache.set(key, picomatch(globs, { dot: true }));
  return matcherCache.get(key);
}

export function componentsForFiles(map, files) {
  const hits = new Map();
  for (const c of map.components) {
    if (!c.files?.length) continue;
    const m = matcher(c.files);
    const own = files.filter((f) => m(f));
    if (own.length) hits.set(c.id, own);
  }
  return hits; // id -> files
}

export function relFile(root, file) {
  return posix(path.isAbsolute(file) ? path.relative(root, file) : file);
}

export function coverage(root, map = loadMap(root)) {
  const files = listSourceFiles(root);
  const owners = new Map(files.map((f) => [f, []]));
  const dead = [];
  for (const c of map.components) {
    if (!c.files?.length) continue;
    const m = matcher(c.files);
    let any = false;
    for (const f of files) if (m(f)) { owners.get(f).push(c.id); any = true; }
    if (!any) dead.push(c.id);
  }
  const unmapped = [], multi = [];
  for (const [f, o] of owners) { if (!o.length) unmapped.push(f); else if (o.length > 1) multi.push({ file: f, components: o }); }
  return { total: files.length, unmapped, multi, dead };
}

// ---------- wiki pages ----------
const wikiDir = (root) => p(root, 'wiki');

function safePage(root, rel) {
  rel = posix(rel).replace(/^\/+/, '');
  if (!rel.endsWith('.md')) rel += '.md';
  const abs = path.resolve(wikiDir(root), rel);
  if (!abs.startsWith(path.resolve(wikiDir(root)) + path.sep)) throw new Error('page path escapes wiki');
  return { rel, abs };
}

export function listPages(root) {
  const dir = wikiDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map(posix)
    .filter((f) => f.endsWith('.md'))
    .map((rel) => readPage(root, rel));
}

export function readPage(root, rel) {
  const { rel: r, abs } = safePage(root, rel);
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, 'utf8');
  const { props, body } = parseFrontmatter(text);
  const title = props.title || (!r.startsWith('_templates/') && /^#\s+(.+)$/m.exec(body)?.[1]) || path.basename(r, '.md');
  return { path: r, name: path.basename(r, '.md'), title, props, body, text, mtime: fs.statSync(abs).mtimeMs };
}

export function writePage(root, rel, text) {
  const { rel: r, abs } = safePage(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return r;
}

export function deletePage(root, rel) {
  const { abs } = safePage(root, rel);
  fs.rmSync(abs, { force: true });
}

export const componentPage = (id) => `components/${id}.md`;

// Rewrite only the AI block under each ## heading; insert one if missing. User text is untouched.
export function writeAiSections(text, sections) {
  let out = text;
  for (const [heading, content] of Object.entries(sections)) {
    const block = `${AI_OPEN}\n${content.trim()}\n${AI_CLOSE}`;
    const lines = out.split('\n');
    const h = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
    if (h === -1) { out = out.replace(/\s*$/, '') + `\n\n## ${heading}\n${block}\n`; continue; }
    let end = lines.findIndex((l, i) => i > h && /^#{1,2}\s/.test(l));
    if (end === -1) end = lines.length;
    const sec = lines.slice(h + 1, end).join('\n');
    const s = sec.indexOf(AI_OPEN), e = sec.indexOf(AI_CLOSE);
    const newSec = s !== -1 && e > s
      ? sec.slice(0, s) + block + sec.slice(e + AI_CLOSE.length)
      : block + '\n' + sec.replace(/^\n+/, '');
    out = [...lines.slice(0, h + 1), newSec, ...lines.slice(end)].join('\n');
  }
  return out;
}

export function resolveLink(pages, map, target) {
  const t = target.toLowerCase().replace(/\.md$/, '');
  const page = pages.find((pg) => pg.path.toLowerCase().replace(/\.md$/, '') === t)
    || pages.find((pg) => pg.name.toLowerCase() === t)
    || pages.find((pg) => pg.title.toLowerCase() === t);
  if (page) return { type: 'page', path: page.path };
  const comp = map.components.find((c) => c.id.toLowerCase() === t || c.name?.toLowerCase() === t);
  if (comp) return { type: 'component', id: comp.id, path: componentPage(comp.id) };
  if (/^d-\d+$/.test(t)) return { type: 'decision', id: target.toUpperCase() };
  return null;
}

export function backlinks(root, rel, pages = listPages(root), map = loadMap(root)) {
  return pages.filter((pg) => pg.path !== rel && wikilinks(pg.body).some((l) => resolveLink(pages, map, l)?.path === rel))
    .map((pg) => ({ path: pg.path, title: pg.title }));
}

// ---------- log + state ----------
export function appendEvent(root, ev) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...ev });
  fs.appendFileSync(p(root, 'log.jsonl'), line + '\n');
}

export function readLog(root, limit = 500) {
  try {
    const lines = fs.readFileSync(p(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// .state.json is local + gitignored: stale components, per-session usage.
export const loadState = (root) => ({ stale: {}, unmapped: [], sessions: {}, ...readJSON(p(root, '.state.json'), {}) });
export const saveState = (root, s) => writeJSON(p(root, '.state.json'), s);

export function markStale(root, files, extra = {}) {
  const map = loadMap(root);
  const hits = componentsForFiles(map, files);
  const state = loadState(root);
  for (const [id, fs_] of hits) state.stale[id] = [...new Set([...(state.stale[id] || []), ...fs_])];
  const mapped = new Set([...hits.values()].flat());
  const unmapped = files.filter((f) => !mapped.has(f) && fs.existsSync(path.join(root, f)));
  state.unmapped = [...new Set([...state.unmapped, ...unmapped])];
  Object.assign(state, extra);
  saveState(root, state);
  return { components: [...hits.keys()], unmapped };
}

// ---------- decisions ----------
export function listDecisions(root) {
  const dir = p(root, 'decisions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => readJSON(path.join(dir, f), null)).filter(Boolean);
}
export const getDecision = (root, id) => readJSON(p(root, 'decisions', `${id}.json`), null);
export const saveDecision = (root, d) => writeJSON(p(root, 'decisions', `${d.id}.json`), d);
export function nextDecisionId(root) {
  const n = listDecisions(root).reduce((m, d) => Math.max(m, +d.id.slice(2) || 0), 0) + 1;
  return `D-${String(n).padStart(4, '0')}`;
}

// ---------- search ----------
const words = (s) => (s || '').toLowerCase().match(/[a-z0-9_]{2,}/g) || [];

function docs(root) {
  const map = loadMap(root);
  const pages = listPages(root);
  const out = [];
  for (const c of map.components) {
    const pg = pages.find((x) => x.path === componentPage(c.id));
    out.push({ kind: 'component', id: c.id, title: c.name || c.id, path: componentPage(c.id), tags: pg?.props.tags || [],
      head: `${c.id} ${c.name} ${c.summary}`, body: pg?.body || '' });
  }
  for (const pg of pages) if (!pg.path.startsWith('components/') && !pg.path.startsWith('_templates/'))
    out.push({ kind: 'page', id: pg.path, title: pg.title, path: pg.path, tags: [].concat(pg.props.tags || []), head: `${pg.title} ${pg.name}`, body: pg.body });
  for (const d of listDecisions(root))
    out.push({ kind: 'decision', id: d.id, title: `${d.id}: ${d.question}`, head: d.question, tags: [], body: JSON.stringify(d) });
  return out;
}

// ponytail: term-frequency scoring, rebuilt per call. Fine for thousands of pages; index on disk if it gets slow.
export function search(root, query, limit = 20) {
  const q = [...new Set(words(query))];
  if (!q.length) return [];
  return docs(root).map((d) => {
    const head = words(d.head + ' ' + [].concat(d.tags).join(' ')), body = words(d.body);
    let score = 0;
    for (const w of q) {
      score += head.filter((x) => x === w || x.startsWith(w)).length * 5;
      score += Math.min(body.filter((x) => x.startsWith(w)).length, 10);
    }
    const i = d.body.toLowerCase().indexOf(q[0]);
    return { kind: d.kind, id: d.id, title: d.title, path: d.path, score, snippet: i >= 0 ? d.body.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, ' ') : '' };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

// Optional semantic search through a local Ollama. Vectors cached by content hash.
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.AGENCY_EMBED_MODEL || 'nomic-embed-text';

export async function ollamaStatus() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(800) });
    const { models = [] } = await r.json();
    return { running: true, model: EMBED_MODEL, hasModel: models.some((m) => m.name.startsWith(EMBED_MODEL)) };
  } catch { return { running: false, model: EMBED_MODEL, hasModel: false }; }
}

async function embed(texts) {
  const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: EMBED_MODEL, input: texts }) });
  if (!r.ok) throw new Error(`ollama embed failed: ${r.status}`);
  return (await r.json()).embeddings;
}

const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / Math.sqrt(x * y); };

export async function semanticSearch(root, query, limit = 20) {
  const all = docs(root);
  const cacheFile = p(root, '.cache', 'embeddings.json');
  const cache = readJSON(cacheFile, {});
  const hash = (d) => crypto.createHash('sha1').update(d.head + d.body).digest('hex');
  const missing = all.filter((d) => !cache[hash(d)]);
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    const vecs = await embed(batch.map((d) => `${d.title}\n${d.head}\n${d.body}`.slice(0, 6000)));
    batch.forEach((d, j) => { cache[hash(d)] = vecs[j]; });
  }
  if (missing.length) writeJSON(cacheFile, cache);
  const [qv] = await embed([query]);
  return all.map((d) => ({ kind: d.kind, id: d.id, title: d.title, path: d.path, score: +cos(qv, cache[hash(d)]).toFixed(3), snippet: d.body.slice(0, 140).replace(/\s+/g, ' ') }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- context briefing for AIs ----------
const tokens = (s) => Math.ceil(s.length / 4);

function section(body, heading) {
  const m = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^#{1,2}\\s|$(?![\\s\\S]))`, 'mi').exec(body);
  return m ? m[1].replace(/<!-- \/?agency:ai -->/g, '').trim() : '';
}

export function context(root, task, budget = 4000) {
  const map = loadMap(root);
  const pages = listPages(root);
  const byId = new Map(map.components.map((c) => [c.id, c]));

  // 1. entry points: search hits + components owning any path mentioned in the task
  // keep only strong hits (>= half the best score) so a passing mention doesn't drag in a component
  const hits = search(root, task, 8).filter((r) => r.kind === 'component');
  const entry = new Set(hits.filter((r) => r.score >= hits[0].score / 2).slice(0, 4).map((r) => r.id));
  const mentioned = (task.match(/[\w./-]+\.\w+/g) || []);
  for (const id of componentsForFiles(map, mentioned).keys()) entry.add(id);

  // 2. graph walk: deps and dependents, 1 hop (2nd hop names only)
  const deps = new Set(), dependents = new Set();
  for (const e of map.edges) {
    if (entry.has(e.from) && !entry.has(e.to)) deps.add(e.to);
    if (entry.has(e.to) && !entry.has(e.from)) dependents.add(e.from);
  }
  const edgeLines = map.edges.filter((e) => entry.has(e.from) || entry.has(e.to)).map((e) => `${e.from} -${e.kind || 'uses'}-> ${e.to}${e.why ? `: ${e.why}` : ''}`);

  // 3. collect pieces in priority order; user notes are never trimmed
  const out = [];
  const add = (prio, text) => text && out.push({ prio, text });
  add(0, `Task touches: ${[...entry].join(', ') || '(no component matched — see map list below)'}${deps.size ? ` | depends on: ${[...deps].join(', ')}` : ''}${dependents.size ? ` | relied on by: ${[...dependents].join(', ')}` : ''}`);
  if (!entry.size) add(0, 'Components: ' + map.components.map((c) => `${c.id} (${c.summary || c.name})`).join('; '));

  const rules = pages.filter(isRule);
  for (const r of rules) {
    const text = r.body.replace(/<!--[\s\S]*?-->/g, '').replace(/^#.*$/gm, '').replace(/^\s*-\s*$/gm, '').trim();
    if (text) add(1, `Rule [[${r.name}]]: ${text}`); // untouched placeholders are empty here
  }

  for (const id of entry) {
    const c = byId.get(id);
    const pg = pages.find((x) => x.path === componentPage(id));
    const notes = pg ? userOwnedText(pg.body).replace(/^#+.*$/gm, '').trim() : '';
    if (notes) add(0, `User notes on ${id}: ${notes}`);
    add(3, `${id}: ${c.summary || ''} files: ${(c.files || []).join(', ')}`);
    const gotchas = pg && section(pg.body, 'Gotchas');
    if (gotchas) add(2, `Gotchas ${id}: ${gotchas}`);
  }
  if (edgeLines.length) add(3, 'Edges: ' + edgeLines.join('; '));

  for (const d of listDecisions(root)) {
    if (!(d.affects || []).some((a) => entry.has(a) || deps.has(a))) continue;
    const chosen = d.options?.find((o) => o.name === d.chosen);
    const rejected = (d.options || []).filter((o) => o.name !== d.chosen).map((o) => o.name);
    add(2, d.status === 'open'
      ? `${d.id} OPEN: ${d.question} — waiting on user, don't build around it yet.`
      : `${d.id} chose "${d.chosen}" (${d.chosen_by})${chosen?.how_it_fits_here ? `: ${chosen.how_it_fits_here}` : ''}. Rejected: ${rejected.join(', ') || 'none'} — don't re-propose without new reason.`);
  }

  const recent = readLog(root, 300).filter((e) => (e.components || []).some((c) => entry.has(c)))
    .map((e) => `${e.at.slice(0, 10)} ${e.actor}: ${e.reason || `${e.kind} ${(e.files || []).join(', ')}`.trim()}`);
  for (const line of [...new Set(recent)].slice(-5)) add(4, line);

  // 4. budget: drop lowest-priority lines until it fits, prio 0 always kept
  out.sort((a, b) => a.prio - b.prio);
  let text = out.map((o) => o.text).join('\n');
  while (tokens(text) > budget && out.length && out[out.length - 1].prio > 0) { out.pop(); text = out.map((o) => o.text).join('\n'); }
  return { components: [...entry], deps: [...deps], dependents: [...dependents], briefing: text, tokens: tokens(text) };
}

// Compact map line for session start: cheap orientation, ~10 tokens per component.
export function mapDigest(root) {
  const map = loadMap(root);
  const out = map.components.map((c) => {
    const to = map.edges.filter((e) => e.from === c.id).map((e) => e.to);
    return `${c.id}${to.length ? '→' + to.join(',') : ''}`;
  });
  return out.join(' | ');
}
