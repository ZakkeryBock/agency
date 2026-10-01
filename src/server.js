// Local GUI server: node:http only, 127.0.0.1 only, random token on every API call.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from './store.js';

const PKG = path.resolve(fileURLToPath(import.meta.url), '../..');
const GUI = path.join(PKG, 'gui');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const STATIC = {
  '/app.js': path.join(GUI, 'dist', 'app.js'),
  '/style.css': path.join(GUI, 'style.css'),
  '/mermaid.js': path.join(PKG, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
};

export function serve(root, port = 4141, open = true) {
  if (!fs.existsSync(STATIC['/app.js'])) { console.error('GUI not built. Run `npm run build` in the agency package.'); process.exit(1); }
  const token = crypto.randomBytes(16).toString('hex');
  const clients = new Set();
  let actualPort = port;

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const readBody = (req) => new Promise((ok, bad) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 5e6) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } });
  });
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  const api = {
    'GET /api/all': () => {
      const st = S.loadState(root);
      return {
        project: path.basename(root), map: S.loadMap(root), stale: st.stale, unmapped: st.unmapped,
        pages: S.listPages(root).map(({ body, text, ...pg }) => pg), decisions: S.listDecisions(root), log: S.readLog(root, 1000),
      };
    },
    'GET /api/page': (q) => S.readPage(root, q.get('path')) || { missing: true },
    'PUT /api/page': async (q, req) => {
      const { path: rel, text, from } = await readBody(req);
      if (from && from !== rel) S.deletePage(root, from);
      const r = S.writePage(root, rel, text);
      S.appendEvent(root, { actor: 'user', kind: 'wiki', page: r, via: 'gui' });
      return { ok: true, path: r };
    },
    'DELETE /api/page': (q) => {
      S.deletePage(root, q.get('path'));
      S.appendEvent(root, { actor: 'user', kind: 'wiki-delete', page: q.get('path'), via: 'gui' });
      return { ok: true };
    },
    'GET /api/backlinks': (q) => S.backlinks(root, q.get('path')),
    'GET /api/search': async (q) => q.get('mode') === 'semantic' ? S.semanticSearch(root, q.get('q') || '') : S.search(root, q.get('q') || ''),
    'GET /api/ollama': () => S.ollamaStatus(),
    'GET /api/context': (q) => S.context(root, q.get('task') || ''),
    'GET /api/coverage': () => S.coverage(root),
    'POST /api/decision': async (q, req) => {
      const { id, option, note } = await readBody(req);
      const d = S.getDecision(root, id);
      if (!d || !d.options.some((o) => o.name === option)) return { error: 'bad decision/option' };
      Object.assign(d, { status: 'chosen', chosen: option, chosen_by: 'user', note: note || undefined, decided: new Date().toISOString() });
      S.saveDecision(root, d);
      S.appendEvent(root, { actor: 'user', kind: 'decision-chosen', decision: id, components: d.affects, reason: option, via: 'gui' });
      return { ok: true };
    },
    'GET /api/history': () => {
      try {
        return git('log', '--format=%H%x09%h%x09%ad%x09%s', '--date=short', '-n', '200', '--', `${S.DIR}/map.json`)
          .trim().split('\n').filter(Boolean).map((l) => { const [sha, short, date, subject] = l.split('\t'); return { sha, short, date, subject }; });
      } catch { return []; }
    },
    'GET /api/map-at': (q) => {
      const sha = q.get('sha') || '';
      if (!/^[0-9a-f]{7,40}$/.test(sha)) return { error: 'bad sha' };
      try { return JSON.parse(git('show', `${sha}:${S.DIR}/map.json`)); } catch { return { components: [], edges: [] }; }
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // DNS-rebinding guard: only our own host names
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${actualPort}$`).test(req.headers.host || '')) return send(res, 403, { error: 'bad host' });

    if (url.pathname === '/' && req.method === 'GET') {
      return send(res, 200, fs.readFileSync(path.join(GUI, 'index.html'), 'utf8'), 'text/html');
    }
    if (STATIC[url.pathname] && req.method === 'GET') {
      const f = STATIC[url.pathname];
      if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, 'not found', 'text/plain');
    if ((req.headers['x-agency-token'] || url.searchParams.get('t')) !== token) return send(res, 401, { error: 'bad token' });

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const h = api[`${req.method} ${url.pathname}`];
    if (!h) return send(res, 404, { error: 'no route' });
    try { send(res, 200, await h(url.searchParams, req)); } catch (e) { send(res, 500, { error: e.message }); }
  });

  // Live reload: any change under .agency/ (AI via MCP, hooks, git checkout) pushes an event. Debounced.
  let t;
  fs.watch(path.join(root, S.DIR), { recursive: true }, (ev, file) => {
    if (file && /\.tmp$|\.cache/.test(file)) return;
    clearTimeout(t);
    t = setTimeout(() => { for (const c of clients) c.write(`data: ${JSON.stringify({ file })}\n\n`); }, 150);
  });

  const listen = (p) => {
    server.once('error', (e) => { if (e.code === 'EADDRINUSE' && p < port + 20) listen(p + 1); else throw e; });
    server.listen(p, '127.0.0.1', () => {
      actualPort = p;
      const url = `http://127.0.0.1:${p}/?t=${token}`;
      console.log(`Agency GUI for ${path.basename(root)}: ${url}`);
      if (open) {
        const [c, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
        execFile(c, args, () => {});
      }
    });
  };
  listen(port);
}
