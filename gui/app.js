// Agency GUI shell: data loading, routing, markdown rendering, palette, and the smaller views.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { segments, WIKILINK_RE, isRule } from '../src/md.js';
import * as MapView from './map.js';
import * as WikiView from './wiki.js';

const token = new URLSearchParams(location.search).get('t');
export const S = { data: null, view: null, ollama: null };

export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'x-agency-token': token, 'content-type': 'application/json' } });
  if (r.status === 401) { toast('Session token expired — reopen the link printed by `agency serve`.'); throw new Error('401'); }
  return r.json();
}

export function h(sel, attrs, ...kids) {
  const [tagId, ...cls] = sel.split('.');
  const [tag, id] = tagId.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (cls.length) el.className = cls.join(' ');
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, ms);
}

export const go = (hash) => { if (location.hash !== hash) location.hash = hash; else route(); };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const actorBadge = (actor) => h(`span.badge.${actor || 'unknown'}`, { title: actor === 'pre-agency' ? 'Existed before Agency was installed' : '' }, { user: 'You', ai: 'AI', 'pre-agency': 'Pre-Agency' }[actor] || 'Unknown');
export const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
export const comp = (id) => S.data.map.components.find((c) => c.id === id);
export const pagePathFor = (id) => `components/${id}.md`;

// ---------- link resolution (mirrors store.resolveLink) ----------
export function resolve(target) {
  const t = target.toLowerCase().replace(/\.md$/, '');
  const { pages, map } = S.data;
  const page = pages.find((p) => p.path.toLowerCase().replace(/\.md$/, '') === t) || pages.find((p) => p.name.toLowerCase() === t) || pages.find((p) => p.title.toLowerCase() === t);
  const c = map.components.find((x) => x.id.toLowerCase() === t || x.name?.toLowerCase() === t);
  if (c && (!page || page.path === pagePathFor(c.id))) return { type: 'component', id: c.id, path: pagePathFor(c.id) };
  if (page) return { type: 'page', path: page.path };
  if (/^d-\d+$/.test(t)) return { type: 'decision', id: target.toUpperCase() };
  return null;
}
export function openLink(target) {
  const r = resolve(target);
  if (!r) return WikiView.newPageDialog(target);
  if (r.type === 'decision') return go(`#/decisions/${r.id}`);
  go(`#/wiki/${r.path}`);
}

// ---------- markdown ----------
function prep(text) {
  // ponytail: wikilinks inside code spans/blocks also get converted; rare in practice.
  return text.replace(WIKILINK_RE, (all, bang, target, anchor, label) => bang
    ? `\n\n<div class="embed" data-embed="${esc(target.trim())}"></div>\n\n`
    : `<a class="wikilink" data-link="${esc(target.trim())}">${esc(label || target.trim())}</a>`);
}
const sanitize = (html) => DOMPurify.sanitize(html, { ADD_ATTR: ['data-link', 'data-embed', 'target'] });
export const mdToHtml = (text) => sanitize(marked.parse(prep(text), { gfm: true, breaks: true }));

export function renderMarkdown(body, { onOwn, rich } = {}) {
  const root = h('div.md');
  let n = -1;
  for (const s of segments(body)) {
    const html = mdToHtml(s.text);
    if (s.ai) {
      const i = ++n;
      const block = h('div.ai-block', { 'data-ai': i, contenteditable: rich ? 'false' : null });
      block.innerHTML = html;
      block.prepend(h('span.ai-label', 'AI-written', onOwn && h('button', { onclick: () => onOwn(i), title: 'Make this your text. The AI will stop rewriting it.' }, 'Take ownership')));
      root.append(block);
    } else {
      const d = document.createElement('div'); d.innerHTML = html; root.append(...d.childNodes);
    }
  }
  enhance(root, { rich });
  return root;
}

let mermaidReady;
function loadMermaid() {
  mermaidReady ??= new Promise((ok, bad) => {
    const s = document.createElement('script'); s.src = '/mermaid.js';
    s.onload = () => { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' }); ok(window.mermaid); };
    s.onerror = bad; document.head.append(s);
  });
  return mermaidReady;
}

let mid = 0;
export function enhance(root, { rich } = {}) {
  root.querySelectorAll('a.wikilink').forEach((a) => {
    if (!resolve(a.dataset.link)) a.classList.add('missing');
    a.title = resolve(a.dataset.link) ? a.dataset.link : `Create "${a.dataset.link}"`;
    a.addEventListener('click', (e) => { if (rich && !e.ctrlKey && !e.metaKey) return; e.preventDefault(); openLink(a.dataset.link); });
  });
  root.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  root.querySelectorAll('div.embed').forEach((el) => {
    el.contentEditable = 'false';
    el.replaceChildren(...embedCard(el.dataset.embed));
    el.addEventListener('click', () => openLink(el.dataset.embed));
    el.style.cursor = 'pointer';
  });
  root.querySelectorAll('blockquote').forEach((bq) => {
    const p = bq.querySelector('p');
    const m = p && /^\[!(\w+)\]\s*/.exec(p.textContent);
    if (!m) return;
    bq.classList.add('callout', m[1].toLowerCase()); bq.dataset.callout = m[1].toLowerCase();
    p.firstChild.textContent = p.firstChild.textContent.replace(/^\[!\w+\]\s*/, '');
    bq.prepend(h('div.callout-title', { contenteditable: 'false' }, m[1]));
  });
  if (rich) root.querySelectorAll('input[type=checkbox]').forEach((c) => { c.disabled = false; c.addEventListener('change', () => c.toggleAttribute('checked', c.checked)); });
  const blocks = root.querySelectorAll('code.language-mermaid');
  if (blocks.length) loadMermaid().then(async (mm) => {
    for (const code of blocks) {
      const src = code.textContent;
      const out = h('div.mermaid-out', { 'data-src': src, contenteditable: 'false', title: rich ? 'Edit diagrams in Source mode' : '' });
      try { out.innerHTML = (await mm.render(`mm${++mid}`, src)).svg; } catch (e) { out.textContent = `Diagram error: ${e.message}`; }
      code.parentElement.replaceWith(out);
    }
  }).catch(() => {});
}

function embedCard(target) {
  const r = resolve(target);
  if (!r) return [h('span.muted', `Missing: ${target}`)];
  if (r.type === 'component') {
    const c = comp(r.id);
    const deps = S.data.map.edges.filter((e) => e.from === c.id).map((e) => e.to);
    return [h('div.embed-kind', `Component · ${c.kind}`), h('b', c.name, ' '), actorBadge(c.origin?.actor), S.data.stale[c.id] ? h('span.badge.stale', ' stale') : '',
      h('div', c.summary || ''), deps.length ? h('div.small.muted', `Depends on: ${deps.join(', ')}`) : ''];
  }
  if (r.type === 'decision') {
    const d = S.data.decisions.find((x) => x.id === r.id);
    if (!d) return [h('span.muted', `Missing: ${target}`)];
    return [h('div.embed-kind', `Decision · ${d.status}`), h('b', `${d.id}: ${d.question}`),
      h('div', d.chosen ? ['Chose ', h('b', d.chosen), ' · ', actorBadge(d.chosen_by)] : h('span.muted', 'Waiting on you'))];
  }
  const pg = S.data.pages.find((p) => p.path === r.path);
  return [h('div.embed-kind', 'Page'), h('b', pg?.title || r.path)];
}

// ---------- palette (Ctrl+K) ----------
let pal = { sel: 0, items: [], mode: 'text', t: null };
function quickItems(q) {
  q = q.toLowerCase();
  const { pages, map, decisions } = S.data;
  const items = [
    ...map.components.map((c) => ({ kind: 'component', title: c.name, sub: c.id, hash: `#/map/${c.id}` })),
    ...pages.filter((p) => !p.path.startsWith('_templates/')).map((p) => ({ kind: 'page', title: p.title, sub: p.path, hash: `#/wiki/${p.path}` })),
    ...decisions.map((d) => ({ kind: 'decision', title: `${d.id} ${d.question}`, sub: d.status, hash: `#/decisions/${d.id}` })),
  ];
  return q ? items.filter((i) => (i.title + ' ' + i.sub).toLowerCase().includes(q)) : items.slice(0, 12);
}
function hashFor(r) { return r.kind === 'decision' ? `#/decisions/${r.id}` : r.kind === 'component' ? `#/map/${r.id}` : `#/wiki/${r.path}`; }

export async function openPalette() {
  const el = document.getElementById('palette');
  S.ollama ??= await api('/api/ollama');
  const input = h('input', { placeholder: 'Jump to a page, component or decision… (Enter searches full text)', 'aria-label': 'Search' });
  const res = h('div.res');
  const semOk = S.ollama.running && S.ollama.hasModel;
  const modes = h('div.modes', 'Search:',
    ...['text', 'semantic'].map((m) => h('button', { class: pal.mode === m ? 'primary' : '', disabled: m === 'semantic' && !semOk, onclick: () => { pal.mode = m; el.hidden = true; openPalette(); } }, m === 'text' ? 'Text' : 'Semantic')),
    h('span.muted', semOk ? `Semantic uses local Ollama (${S.ollama.model})` : S.ollama.running ? `Run: ollama pull ${S.ollama.model}` : 'Semantic needs Ollama running locally (optional)'));
  const paint = () => {
    res.replaceChildren(...pal.items.map((it, i) => h(`div.r${i === pal.sel ? '.sel' : ''}`, { onclick: () => { el.hidden = true; go(it.hash); } },
      h('span.badge.outline', it.kind), h('span', it.title), h('span.snip', it.sub || ''))));
  };
  const runFull = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const r = await api(`/api/search?mode=${pal.mode}&q=${encodeURIComponent(q)}`);
    if (r.error) return toast(r.error);
    const full = r.map((x) => ({ kind: x.kind, title: x.title, sub: x.snippet || `score ${x.score}`, hash: hashFor(x) }));
    const seen = new Set(full.map((x) => x.hash));
    pal.items = pal.mode === 'semantic' ? full : [...quickItems(q).filter((x) => !seen.has(x.hash)).slice(0, 5), ...full];
    pal.sel = 0; paint();
  };
  input.addEventListener('input', () => {
    pal.items = quickItems(input.value); pal.sel = 0; paint();
    clearTimeout(pal.t); pal.t = setTimeout(runFull, pal.mode === 'semantic' ? 500 : 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); paint(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { pal.sel = Math.max(pal.sel - 1, 0); paint(); e.preventDefault(); }
    if (e.key === 'Enter' && pal.items[pal.sel]) { el.hidden = true; go(pal.items[pal.sel].hash); }
    if (e.key === 'Escape') el.hidden = true;
  });
  el.replaceChildren(h('div.box', input, modes, res));
  el.onclick = (e) => { if (e.target === el) el.hidden = true; };
  el.hidden = false;
  pal.items = quickItems(''); pal.sel = 0; paint();
  input.focus();
}

export function modal(title, fields, onSubmit, submitLabel = 'Save') {
  const el = document.getElementById('modal');
  const form = h('form.box', { onsubmit: (e) => { e.preventDefault(); const v = Object.fromEntries(new FormData(form)); el.hidden = true; onSubmit(v); } },
    h('b', title), ...fields,
    h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, h('button', { type: 'button', onclick: () => { el.hidden = true; } }, 'Cancel'), h('button.primary', { type: 'submit' }, submitLabel)));
  el.replaceChildren(form);
  el.onclick = (e) => { if (e.target === el) el.hidden = true; };
  el.hidden = false;
  form.querySelector('input,select,textarea')?.focus();
}

// ---------- decisions ----------
const lvl = { S: 'good', M: 'mid', L: 'bad', easy: 'good', moderate: 'mid', hard: 'bad', none: 'good', low: 'mid', high: 'bad' };
const compChips = (ids, label) => ids?.length ? h('div.small', h('span.lbl', label, ' '), ...ids.map((id) => h('span.tag', { onclick: () => go(`#/map/${id}`) }, id))) : '';

const DecisionsView = {
  mount(el, arg) {
    const ds = [...S.data.decisions].reverse();
    const open = ds.filter((d) => d.status === 'open'), done = ds.filter((d) => d.status !== 'open');
    if (!ds.length) return el.replaceChildren(h('div.empty', h('h2', 'No decisions yet'), h('p', 'When your AI hits a major fork — a new library, service, schema change — it opens a decision here with every option explained, linked, and mapped. You pick; the map remembers you chose it.')));
    const wrap = h('div.dec', open.length ? h('h3.muted', `Waiting on you (${open.length})`) : '', ...open.map(card),
      done.length ? h('h3.muted', 'History') : '', ...done.map(card));
    el.replaceChildren(h('div.scroll', wrap));
    if (arg) wrap.querySelector(`[data-id="${CSS.escape(arg)}"]`)?.scrollIntoView({ block: 'start' });
  },
};

function card(d) {
  if (d.minor) return h('div.dec-card', { 'data-id': d.id, style: 'padding:12px 16px' },
    h('div.meta', h('span.badge.outline', d.id), actorBadge('ai'), h('span.muted.small', fmtDate(d.created))),
    h('b', d.question), ' → ', h('b', d.chosen), h('div.muted', d.context), compChips(d.affects, 'Affects'));
  const preview = (o) => go(`#/map?hl=${(d.affects || []).join(',')}&add=${(o?.adds_components || []).join(',')}&chg=${(o?.changes_components || []).join(',')}&d=${d.id}`);
  return h(`div.dec-card${d.status === 'open' ? '.open' : ''}`, { 'data-id': d.id },
    h('div.meta', h('span.badge.outline', d.id), d.status === 'open' ? h('span.badge.decision', 'Open') : h('span.badge.outline', 'Decided'),
      h('span.muted.small', `proposed by ${d.agent || 'AI'} · ${fmtDate(d.created)}`)),
    h('h2', d.question), h('p', d.context), compChips(d.affects, 'Affects'),
    h('div.options', ...d.options.map((o) => {
      const rec = d.recommendation?.option === o.name, chosen = d.chosen === o.name;
      const L = o.links || {};
      return h(`div.opt${rec ? '.rec' : ''}${chosen ? '.chosen' : ''}`,
        h('h3', o.name, h('span', rec ? h('span.badge', { style: 'background:var(--accent)' }, 'Recommended') : '', ' ', chosen ? h('span.badge', { style: 'background:var(--ok)' }, 'Chosen') : '')),
        h('div', o.what_it_is),
        o.how_it_fits_here && h('div', h('div.lbl', 'In this project'), o.how_it_fits_here),
        h('div.facts',
          h('div', 'Effort', h('b', { class: lvl[o.effort] }, o.effort)),
          h('div', { title: o.reversibility_why || '' }, 'Reversible', h('b', { class: lvl[o.reversibility] }, o.reversibility)),
          h('div', 'Lock-in', h('b', { class: lvl[o.lock_in] }, o.lock_in)),
          h('div', 'Cost', h('b', o.cost))),
        o.reversibility_why && h('div.small.muted', o.reversibility_why),
        o.pros?.length && h('div', h('div.lbl.good', 'Pros'), h('ul', ...o.pros.map((x) => h('li', x)))),
        o.cons?.length && h('div', h('div.lbl.bad', 'Cons'), h('ul', ...o.cons.map((x) => h('li', x)))),
        compChips(o.adds_components, 'Adds'), compChips(o.changes_components, 'Changes'),
        (L.docs || L.repo || L.license || L.maturity) && h('div.links', L.docs && h('a', { href: L.docs, target: '_blank', rel: 'noopener noreferrer' }, 'Docs ↗'),
          L.repo && h('a', { href: L.repo, target: '_blank', rel: 'noopener noreferrer' }, 'Repo ↗'),
          L.license && h('span.small.muted', L.license, ' '), L.maturity && h('span.small.muted', '· ', L.maturity)),
        h('div.actions',
          h('button', { onclick: () => preview(o) }, 'Preview on map'),
          d.status === 'open' && h('button.primary', { onclick: () => choose(d, o.name) }, 'Choose this')));
    })),
    d.recommendation && h('div.rec-box', h('b', `AI recommends ${d.recommendation.option}: `), d.recommendation.why,
      d.recommendation.would_change_mind_if && h('div.small.muted', 'Would change its mind if: ', d.recommendation.would_change_mind_if)),
    d.chosen && h('p', 'Chose ', h('b', d.chosen), ' · ', actorBadge(d.chosen_by), ' ', h('span.muted.small', fmtDate(d.decided)), d.note ? h('div', h('i', `“${d.note}”`)) : ''));
}

function choose(d, option) {
  modal(`Choose "${option}" for ${d.id}?`, [h('label', 'Note for the AI (optional)', h('textarea', { name: 'note', placeholder: 'e.g. keep it behind a feature flag' }))], async ({ note }) => {
    const r = await api('/api/decision', { method: 'POST', body: JSON.stringify({ id: d.id, option, note }) });
    if (r.error) return toast(r.error);
    toast(`Chosen. Tell your AI to continue — it reads ${d.id}.`);
  }, 'Choose');
}

// ---------- timeline ----------
const KIND = {
  edit: (e) => ['edited ', h('span.mono', (e.files || []).join(', '))],
  wiki: (e) => ['updated page ', h('a', { href: `#/wiki/${e.page}` }, e.page)],
  'wiki-delete': (e) => ['deleted page ', e.page],
  map: (e) => ['changed the map', e.reason ? `: ${e.reason}` : ''],
  refresh: (e) => ['refreshed docs', e.reason ? `: ${e.reason}` : ''],
  commit: (e) => [h('span.mono', e.commit), ' ', e.reason, e.inferred ? h('span.small.muted', ` · ${e.userFiles.length} file(s) not touched by any AI hook → attributed to you (inferred)`) : ''],
  'decision-open': (e) => ['opened ', h('a', { href: `#/decisions/${e.decision}` }, e.decision), `: ${e.reason}`],
  'decision-chosen': (e) => ['chose ', h('b', e.reason), ' in ', h('a', { href: `#/decisions/${e.decision}` }, e.decision), e.via ? ` (via ${e.via})` : ''],
  'decision-ai': (e) => ['decided ', h('a', { href: `#/decisions/${e.decision}` }, e.decision), `: ${e.reason}`],
  init: (e) => [h('b', 'Agency installed'), ' — everything earlier is pre-Agency'],
};
const tlFilter = { actor: '', kind: '', q: '' };
const TimelineView = {
  mount(el) {
    const list = h('div.tl');
    const paint = () => {
      const evs = [...S.data.log].reverse().filter((e) => (!tlFilter.actor || e.actor === tlFilter.actor) && (!tlFilter.kind || e.kind.startsWith(tlFilter.kind))
        && (!tlFilter.q || JSON.stringify(e).toLowerCase().includes(tlFilter.q.toLowerCase())));
      let day = '';
      const rows = [];
      for (const e of evs.slice(0, 600)) {
        const d = new Date(e.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        if (d !== day) { day = d; rows.push(h('div.day', d)); }
        rows.push(h('div.ev',
          h('span.time', new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
          h('span', actorBadge(e.actor)),
          h('div.what', ...(KIND[e.kind] || ((x) => [x.kind]))(e), ' ',
            e.components?.length ? h('span.comps', ...e.components.map((c) => h('span', { onclick: () => go(`#/map/${c}`) }, c))) : '',
            e.agent ? h('span.small.muted', ` · ${e.agent}`) : '')));
      }
      list.replaceChildren(...(rows.length ? rows : [h('div.empty', 'Nothing yet. Edits by you and your AI will appear here.')]));
    };
    const sel = (key, opts) => h('select', { onchange: (e) => { tlFilter[key] = e.target.value; paint(); } }, ...opts.map(([v, l]) => h('option', { value: v, selected: tlFilter[key] === v }, l)));
    el.replaceChildren(h('div.col',
      h('div.toolbar', sel('actor', [['', 'Everyone'], ['user', 'You'], ['ai', 'AI']]),
        sel('kind', [['', 'All events'], ['edit', 'Code edits'], ['commit', 'Commits'], ['wiki', 'Wiki'], ['map', 'Map'], ['decision', 'Decisions']]),
        h('input', { placeholder: 'Filter…', value: tlFilter.q, oninput: (e) => { tlFilter.q = e.target.value; paint(); } }),
        h('span.grow'), h('span.small.muted', `${S.data.log.length} events`)),
      h('div.scroll', list)));
    paint();
  },
};

// ---------- AI view: what the AI sees ----------
let lastTask = '';
const AiView = {
  mount(el) {
    const { map, pages, log } = S.data;
    const by = (a) => map.components.filter((c) => (c.origin?.actor || 'pre-agency') === a).length;
    const today = log.filter((e) => e.actor === 'ai' && new Date(e.at).toDateString() === new Date().toDateString()).length;
    const rules = pages.filter(isRule);
    const ta = h('textarea', { placeholder: 'Describe a task, e.g. "add password reset emails"', value: lastTask });
    const out = h('div');
    const run = async () => {
      lastTask = ta.value.trim();
      if (!lastTask) return;
      const r = await api(`/api/context?task=${encodeURIComponent(lastTask)}`);
      out.replaceChildren(
        h('div.stat-row', h('div.stat', h('b', `~${r.tokens}`), 'tokens'), h('div.stat', h('b', r.components.length), 'entry components'),
          h('div.stat', h('b', r.deps.length + r.dependents.length), 'neighbors pulled in')),
        h('div.toolbar', { style: 'border:none;padding:0 0 8px;background:none' }, h('button', { onclick: () => go(`#/map?hl=${[...r.components, ...r.deps, ...r.dependents].join(',')}`) }, 'Show on map')),
        h('div.briefing', r.briefing));
    };
    el.replaceChildren(h('div.scroll', h('div.aiview',
      h('h2', 'What the AI sees'),
      h('p.muted', 'Before non-trivial work the AI calls agency_context(task) and gets exactly this briefing instead of re-reading your codebase. Your notes, rule pages and decisions are part of it. Try a task:'),
      ta, h('div', { style: 'margin:8px 0' }, h('button.primary', { onclick: run }, 'Build briefing')), out,
      h('h3', 'Memory health'),
      h('div.stat-row', h('div.stat', h('b', map.components.length), 'components'), h('div.stat', h('b', by('user')), 'added by you'), h('div.stat', h('b', by('ai')), 'added by AI'),
        h('div.stat', h('b', by('pre-agency')), 'pre-Agency'), h('div.stat', h('b', rules.length), 'rule pages'), h('div.stat', h('b', today), 'AI events today')),
      rules.length ? h('p', 'Rules every session follows: ', ...rules.map((p) => h('a.tag', { href: `#/wiki/${p.path}` }, p.title))) : h('p.muted', 'Tip: tag a wiki page "convention" and every AI session will follow it.'))));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });
    if (lastTask) run();
  },
};

// ---------- shell ----------
const VIEWS = { map: MapView, wiki: WikiView, decisions: DecisionsView, timeline: TimelineView, ai: AiView };
let current = { tab: null, arg: null };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const [tab, ...rest] = pathPart.split('/');
  return { tab: VIEWS[tab] ? tab : 'map', arg: decodeURIComponent(rest.join('/')), query: new URLSearchParams(query) };
}

export function route() {
  const { tab, arg, query } = parseHash();
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  const el = document.getElementById('view');
  if (current.tab === tab && VIEWS[tab].navigate?.(arg, query)) { current.arg = arg; return; }
  if (current.tab !== tab) { VIEWS[current.tab]?.unmount?.(); el.replaceChildren(); }
  current = { tab, arg };
  VIEWS[tab].mount(el, arg, query);
}

function chrome() {
  const { decisions, stale, unmapped, project } = S.data;
  document.getElementById('project').textContent = `· ${project}`;
  document.title = `Agency · ${project}`;
  const open = decisions.filter((d) => d.status === 'open').length;
  const dc = document.getElementById('dec-count');
  dc.hidden = !open; dc.textContent = open;
  const n = Object.keys(stale).length;
  document.getElementById('chips').replaceChildren(...[
    n && h('span.chip.warn', { title: 'Code changed since these docs were updated. The AI refreshes them at the end of its turn.', onclick: () => go('#/map?stale=1') }, `${n} stale`),
    unmapped.length && h('span.chip.warn', { title: unmapped.join('\n'), onclick: () => go('#/map') }, `${unmapped.length} unmapped file${unmapped.length > 1 ? 's' : ''}`),
  ].filter(Boolean));
}

export async function load() {
  S.data = await api('/api/all');
  chrome();
}

let reloadT;
function live() {
  const dot = document.getElementById('live');
  const es = new EventSource(`/api/events?t=${token}`);
  es.onopen = () => dot.classList.add('on');
  es.onerror = () => dot.classList.remove('on');
  es.onmessage = () => {
    clearTimeout(reloadT);
    reloadT = setTimeout(async () => {
      await load();
      dot.classList.remove('pulse'); void dot.offsetWidth; dot.classList.add('pulse');
      const v = VIEWS[current.tab];
      if (v.update) v.update(); else route();
    }, 120);
  };
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => go(`#/${b.dataset.tab}`)));
document.getElementById('open-search').addEventListener('click', openPalette);
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape') { document.getElementById('palette').hidden = true; document.getElementById('modal').hidden = true; }
});
addEventListener('hashchange', route);

await load();
route();
live();
