// Map tab: interactive component graph with origin colors, stale markers, history diff and decision previews.
import cytoscape from 'cytoscape';
import { S, h, api, go, actorBadge, fmtDate, comp, renderMarkdown, pagePathFor, toast } from './app.js';

let lastQuery = '';
let cy = null, el = null, side = null, opts = {}, view = { actor: '', at: '' }, pastMap = null;
const SHAPES = { service: 'round-rectangle', module: 'round-rectangle', ui: 'round-tag', datastore: 'barrel', external: 'diamond', infra: 'hexagon', tooling: 'round-octagon' };
const posKey = () => `agency.pos.${S.data.project}`;
const savedPos = () => { try { return JSON.parse(localStorage.getItem(posKey()) || '{}'); } catch { return {}; } };
const savePos = () => { try { localStorage.setItem(posKey(), JSON.stringify(Object.fromEntries(cy.nodes().map((n) => [n.id(), n.position()])))); } catch {} };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function elements() {
  const now = S.data.map;
  const nodes = new Map(), edges = new Map();
  for (const c of now.components) nodes.set(c.id, { ...c, status: '' });
  for (const e of now.edges) edges.set(`${e.from}>${e.to}`, { ...e, status: '' });
  if (pastMap) {
    // diff: what changed between the chosen commit and now
    const then = new Map(pastMap.components.map((c) => [c.id, c]));
    for (const [id, c] of nodes) {
      const t = then.get(id);
      c.status = !t ? 'added' : (t.summary !== c.summary || JSON.stringify(t.files) !== JSON.stringify(c.files)) ? 'changed' : '';
    }
    for (const [id, t] of then) if (!nodes.has(id)) nodes.set(id, { ...t, status: 'removed' });
    const thenE = new Set(pastMap.edges.map((e) => `${e.from}>${e.to}`));
    for (const [k, e] of edges) if (!thenE.has(k)) e.status = 'added';
    for (const e of pastMap.edges) { const k = `${e.from}>${e.to}`; if (!edges.has(k)) edges.set(k, { ...e, status: 'removed' }); }
  }
  for (const id of opts.add || []) if (!nodes.has(id)) nodes.set(id, { id, name: id, kind: 'module', status: 'proposed', origin: { actor: 'ai' } });
  return [
    ...[...nodes.values()].map((c) => ({ group: 'nodes', data: { id: c.id, label: c.name || c.id, shape: SHAPES[c.kind] || 'round-rectangle', actor: c.origin?.actor || 'pre-agency' },
      classes: [c.status, S.data.stale[c.id] && 'stale'].filter(Boolean).join(' ') })),
    ...[...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to))
      .map((e) => ({ group: 'edges', data: { id: `${e.from}>${e.to}`, source: e.from, target: e.to, label: e.kind || '' }, classes: e.status })),
  ];
}

function style() {
  const col = { user: css('--user'), ai: css('--ai'), 'pre-agency': css('--pre') };
  return [
    { selector: 'node', style: { shape: 'data(shape)', 'background-color': (n) => col[n.data('actor')] || col['pre-agency'], label: 'data(label)', color: css('--text'),
      'font-size': 11, 'font-family': css('--font'), 'text-valign': 'bottom', 'text-margin-y': 6, width: 46, height: 34, 'border-width': 0, 'text-wrap': 'wrap', 'text-max-width': 120 } },
    { selector: 'edge', style: { width: 1.6, 'line-color': css('--line'), 'target-arrow-color': css('--muted'), 'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
      label: 'data(label)', 'font-size': 9, color: css('--muted'), 'text-rotation': 'autorotate', 'text-background-color': css('--bg'), 'text-background-opacity': 1, 'text-background-padding': 2 } },
    { selector: 'node.stale', style: { 'border-width': 3, 'border-color': css('--stale'), 'border-style': 'dashed' } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': css('--accent'), 'border-style': 'solid' } },
    { selector: '.added', style: { 'border-width': 3, 'border-color': css('--ok'), 'line-color': css('--ok'), 'target-arrow-color': css('--ok') } },
    { selector: 'node.changed', style: { 'border-width': 3, 'border-color': css('--user'), 'border-style': 'double' } },
    { selector: '.removed', style: { opacity: 0.45, 'border-width': 2, 'border-color': css('--danger'), 'border-style': 'dashed', 'line-style': 'dashed', 'line-color': css('--danger') } },
    { selector: 'node.proposed', style: { 'background-opacity': 0.25, 'border-width': 2, 'border-style': 'dashed', 'border-color': css('--decision') } },
    { selector: '.hl', style: { 'border-width': 4, 'border-color': css('--decision'), 'border-style': 'solid' } },
    { selector: '.dim', style: { opacity: 0.18 } },
    { selector: 'edge.hl-edge', style: { 'line-color': css('--accent'), 'target-arrow-color': css('--accent'), width: 2.5 } },
  ];
}

// New nodes are placed next to their neighbors so the user's arrangement survives updates.
function layout(all) {
  const pos = savedPos();
  const missing = cy.nodes().filter((n) => !pos[n.id()]);
  if (all || missing.length === cy.nodes().length) {
    // dependency graphs read best top-down: things that call others above what they call
    const l = cy.layout({ name: 'breadthfirst', directed: true, spacingFactor: 1.15, padding: 50, avoidOverlap: true, nodeDimensionsIncludeLabels: true });
    l.one('layoutstop', () => { savePos(); fit(); });
    l.run();
    return;
  }
  const placed = cy.nodes().filter((n) => pos[n.id()]);
  placed.positions((n) => pos[n.id()]);
  const bb = placed.boundingBox();
  missing.forEach((n, i) => {
    const nb = n.neighborhood('node').filter((m) => pos[m.id()]);
    const base = nb.length
      ? { x: nb.reduce((s, m) => s + pos[m.id()].x, 0) / nb.length, y: nb.reduce((s, m) => s + pos[m.id()].y, 0) / nb.length }
      : { x: bb.x2 + 90, y: bb.y1 + i * 70 };
    n.position({ x: base.x + 70 * Math.cos(i * 2.4 + 1), y: base.y + 70 * Math.sin(i * 2.4 + 1) });
  });
  if (missing.length) savePos();
}

const fit = () => { cy.fit(undefined, 50); if (cy.zoom() > 1.1) { cy.zoom(1.1); cy.center(); } };

function applyFilters() {
  cy.elements().removeClass('dim hl hl-edge');
  const hl = new Set([...(opts.hl || []), ...(opts.chg || []), ...(opts.add || [])]);
  if (hl.size) {
    cy.nodes().forEach((n) => n.addClass(hl.has(n.id()) ? 'hl' : 'dim'));
    cy.edges().forEach((e) => { if (!hl.has(e.source().id()) && !hl.has(e.target().id())) e.addClass('dim'); });
  }
  if (view.actor) cy.nodes().forEach((n) => { if (n.data('actor') !== view.actor) n.addClass('dim'); });
  if (opts.stale) cy.nodes().forEach((n) => { if (!n.hasClass('stale')) n.addClass('dim'); });
}

function overview() {
  const { map, stale, unmapped } = S.data;
  if (!map.components.length) return [h('h2', 'No map yet'),
    h('p', 'Agency maps your project with your AI so components get names a human would use.'),
    h('p', 'In Claude Code, say:'), h('pre.mono', 'map this project with agency'),
    h('p.muted', 'The map, wiki pages and edges appear here live as the AI writes them.')];
  const by = (a) => map.components.filter((c) => (c.origin?.actor || 'pre-agency') === a).length;
  return [h('h2', S.data.project),
    h('p.muted', `${map.components.length} components · ${map.edges.length} connections`),
    h('div.meta', actorBadge('user'), `${by('user')}`, actorBadge('ai'), `${by('ai')}`, actorBadge('pre-agency'), `${by('pre-agency')}`),
    Object.keys(stale).length ? [h('h3', 'Stale — code changed, docs not yet'), h('ul.linklist', ...Object.entries(stale).map(([id, f]) => h('li', { onclick: () => go(`#/map/${id}`) }, id, h('span.why', f.join(', ')))))] : '',
    unmapped.length ? [h('h3', 'New files not on the map'), h('ul.linklist', ...unmapped.slice(0, 20).map((f) => h('li.mono', f)))] : '',
    pastMap ? [h('h3', 'Comparing'), h('p', 'Green = added since that commit, double blue = changed, red dashed = removed.')] : '',
    opts.d ? [h('h3', 'Decision preview'), h('p', 'Pink = affected or changed, faded dashed = would be added. ', h('a', { href: `#/decisions/${opts.d}` }, `Back to ${opts.d}`))] : '',
    h('h3', 'Tips'), h('p.small.muted', 'Click a component for its wiki page and connections. Drag to arrange — positions are remembered. Colors show who added it.')];
}

function details(id) {
  const c = comp(id);
  if (!c) return overview();
  const { map, log } = S.data;
  const pg = S.data.pages.find((p) => p.path === pagePathFor(id));
  const out = map.edges.filter((e) => e.from === id), inn = map.edges.filter((e) => e.to === id);
  const body = h('div', h('span.muted.small', 'Loading page…'));
  api(`/api/page?path=${encodeURIComponent(pagePathFor(id))}`).then((p) => body.replaceChildren(p.missing ? h('p.muted', 'No wiki page yet.') : renderMarkdown(p.body.replace(/^#\s.*\n/, ''))));
  const events = log.filter((e) => e.components?.includes(id)).slice(-6).reverse();
  const o = c.origin || { actor: 'pre-agency' };
  return [h('h2', c.name),
    h('div.meta', h('span.badge.outline', c.kind), actorBadge(o.actor), o.decision && h('span.badge.decision', { onclick: () => go(`#/decisions/${o.decision}`), title: 'Added because of this decision' }, o.decision),
      S.data.stale[id] && h('span.badge.stale', { title: S.data.stale[id].join('\n') }, 'stale')),
    h('p', c.summary),
    h('div.small.muted', o.actor === 'pre-agency' ? 'Existed before Agency was installed.' : `Added by ${o.actor === 'user' ? 'your decision' : o.agent || 'AI'} · ${fmtDate(o.at)}`),
    h('div', { style: 'margin:10px 0' }, h('button', { onclick: () => go(`#/wiki/${pagePathFor(id)}`) }, pg ? 'Open wiki page' : 'Create wiki page')),
    out.length ? [h('h3', `Relies on (${out.length})`), h('ul.linklist', ...out.map((e) => h('li', { onclick: () => go(`#/map/${e.to}`) }, h('b', comp(e.to)?.name || e.to), ` · ${e.kind}`, h('span.why', e.why || ''))))] : '',
    inn.length ? [h('h3', `Relied on by (${inn.length})`), h('ul.linklist', ...inn.map((e) => h('li', { onclick: () => go(`#/map/${e.from}`) }, h('b', comp(e.from)?.name || e.from), ` · ${e.kind}`, h('span.why', e.why || ''))))] : '',
    h('h3', 'Files'), h('div.globs', ...(c.files || []).map((g) => h('code', g))),
    h('h3', 'Wiki'), body,
    events.length ? [h('h3', 'Recent activity'), h('ul.linklist', ...events.map((e) => h('li', { onclick: () => go('#/timeline') }, actorBadge(e.actor), ` ${e.kind} `, h('span.why', `${fmtDate(e.at)} ${e.reason || (e.files || []).join(', ')}`))))] : ''];
}

function edgeDetails(edge) {
  const e = S.data.map.edges.find((x) => `${x.from}>${x.to}` === edge.id());
  if (!e) return overview();
  return [h('h2', `${comp(e.from)?.name || e.from} → ${comp(e.to)?.name || e.to}`), h('div.meta', h('span.badge.outline', e.kind)), h('p', e.why || h('span.muted', 'No reason recorded.')),
    h('ul.linklist', h('li', { onclick: () => go(`#/map/${e.from}`) }, comp(e.from)?.name || e.from), h('li', { onclick: () => go(`#/map/${e.to}`) }, comp(e.to)?.name || e.to))];
}

function showSide(id) {
  side.replaceChildren(h('div.panel', ...[id ? details(id) : overview()].flat(3)));
}

export async function mount(container, arg, query) {
  el = container;
  opts = { hl: query.get('hl')?.split(',').filter(Boolean), add: query.get('add')?.split(',').filter(Boolean), chg: query.get('chg')?.split(',').filter(Boolean), d: query.get('d'), stale: query.get('stale') };
  const history = await api('/api/history');
  const histSel = h('select', { title: 'Compare the map with an earlier commit', onchange: async (e) => {
    view.at = e.target.value;
    pastMap = view.at ? await api(`/api/map-at?sha=${view.at}`) : null;
    rebuild(); showSide(null);
  } }, h('option', { value: '' }, 'Now'), ...history.map((c) => h('option', { value: c.sha, selected: view.at === c.sha }, `vs ${c.short} · ${c.date} · ${c.subject.slice(0, 40)}`)));
  if (!history.length) { histSel.disabled = true; histSel.title = 'History appears once .agency/map.json is committed to git'; }
  const find = h('input', { placeholder: 'Find component…', list: 'comp-list', onchange: (e) => { const n = cy.nodes().filter((x) => x.data('label').toLowerCase() === e.target.value.toLowerCase() || x.id() === e.target.value); if (n.length) go(`#/map/${n.id()}`); e.target.value = ''; } });
  const dl = h('datalist', { id: 'comp-list' }, ...S.data.map.components.map((c) => h('option', { value: c.name })));
  const canvas = h('div#cy');
  side = h('aside.side');
  container.replaceChildren(h('div.split',
    h('div.col',
      h('div.toolbar',
        h('select', { onchange: (e) => { view.actor = e.target.value; applyFilters(); } }, ...[['', 'Everyone'], ['user', 'Added by you'], ['ai', 'Added by AI'], ['pre-agency', 'Pre-Agency']].map(([v, l]) => h('option', { value: v, selected: view.actor === v }, l))),
        histSel, find, dl, h('span.grow'),
        (opts.hl || opts.stale) && h('button', { onclick: () => go('#/map') }, 'Clear highlight'),
        h('button', { onclick: () => { layout(true); }, title: 'Re-arrange automatically' }, 'Re-layout'),
        h('button', { onclick: () => fit() }, 'Fit')),
      h('div', { style: 'position:relative;flex:1;min-height:0;display:flex' }, canvas,
        h('div.legend', h('div', h('i', { style: 'background:var(--user)' }), 'Added by you'), h('div', h('i', { style: 'background:var(--ai)' }), 'Added by AI'),
          h('div', h('i', { style: 'background:var(--pre)' }), 'Pre-Agency'), h('div', h('i', { style: 'background:none;border:2px dashed var(--stale)' }), 'Stale docs')))),
    side));
  pastMap = view.at ? await api(`/api/map-at?sha=${view.at}`) : null;
  cy = cytoscape({ container: canvas, elements: elements(), style: style(), wheelSensitivity: 0.25, minZoom: 0.2, maxZoom: 3 });
  layout(false);
  fit();
  lastQuery = query.toString();
  cy.on('tap', 'node', (e) => { if (comp(e.target.id())) go(`#/map/${e.target.id()}`); });
  cy.on('tap', 'edge', (e) => side.replaceChildren(h('div.panel', ...edgeDetails(e.target).flat(2))));
  cy.on('tap', (e) => { if (e.target === cy) go('#/map'); });
  cy.on('dragfree', 'node', savePos);
  cy.on('mouseover', 'node', (e) => { e.target.connectedEdges().addClass('hl-edge'); canvas.style.cursor = 'pointer'; });
  cy.on('mouseout', 'node', (e) => { e.target.connectedEdges().removeClass('hl-edge'); canvas.style.cursor = ''; });
  matchMedia('(prefers-color-scheme: dark)').onchange = () => cy?.style(style());
  select(arg);
  applyFilters();
  if (opts.d && opts.add?.length) toast('Faded dashed nodes would be added by this option.');
}

function select(id) {
  cy.nodes().unselect();
  if (id && cy.$id(id).length) { cy.$id(id).select(); cy.animate({ center: { eles: cy.$id(id) }, duration: 250 }); }
  showSide(id || null);
}

function rebuild() {
  const want = elements();
  const ids = new Set(want.map((x) => x.data.id));
  cy.batch(() => {
    cy.elements().filter((x) => !ids.has(x.id())).remove();
    for (const x of want) {
      const cur = cy.getElementById(x.data.id);
      if (cur.length) { cur.data(x.data); cur.classes(x.classes || ''); } else cy.add(x);
    }
  });
  layout(false);
  applyFilters();
}

export function update() {
  if (!cy) return;
  rebuild();
  const sel = cy.nodes(':selected');
  showSide(sel.length ? sel.id() : null);
}

// Same tab, same query: just change selection instead of rebuilding the graph.
export function navigate(arg, query) {
  if (!cy || query.toString() !== lastQuery) return false;
  select(arg);
  return true;
}

export function unmount() { cy?.destroy(); cy = null; }
