// Wiki tab: page tree, properties, two editor modes (Source+Preview vs Rich) so both can be tried side by side,
// wikilinks/backlinks, slash menu, templates and a table view over page properties.
import { EditorView, minimalSetup } from 'codemirror';
import { ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion } from '@codemirror/autocomplete';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { parseFrontmatter, stringifyFrontmatter, segments, takeOwnership, wikilinks } from '../src/md.js';
import { S, h, api, go, toast, modal, renderMarkdown, actorBadge, fmtDate, resolve } from './app.js';

const ls = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let st = {};
let container, sideEl, mainEl;

// ---------- slash blocks (shared by both editors) ----------
const BLOCKS = [
  { name: 'Heading 1', md: '# ', html: '<h1>Heading</h1>' },
  { name: 'Heading 2', md: '## ', html: '<h2>Heading</h2>' },
  { name: 'Heading 3', md: '### ', html: '<h3>Heading</h3>' },
  { name: 'Checklist', md: '- [ ] ', html: '<ul><li><input type="checkbox"> To do</li></ul>' },
  { name: 'Bulleted list', md: '- ', html: '<ul><li>Item</li></ul>' },
  { name: 'Numbered list', md: '1. ', html: '<ol><li>Item</li></ol>' },
  { name: 'Quote', md: '> ', html: '<blockquote><p>Quote</p></blockquote>' },
  { name: 'Callout', md: '> [!note] ', html: '<blockquote class="callout note" data-callout="note"><p>Note</p></blockquote>' },
  { name: 'Warning callout', md: '> [!warning] ', html: '<blockquote class="callout warning" data-callout="warning"><p>Careful</p></blockquote>' },
  { name: 'Code block', md: '```\n\n```', cursor: 4, html: '<pre><code>code</code></pre>' },
  { name: 'Table', md: '| Column | Column |\n| --- | --- |\n|  |  |\n', html: '<table><thead><tr><th>Column</th><th>Column</th></tr></thead><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p></p>' },
  { name: 'Diagram (Mermaid)', md: '```mermaid\ngraph LR\n  A --> B\n```\n', html: '<p>Diagrams are edited in Source mode.</p>' },
  { name: 'Divider', md: '---\n', html: '<hr><p></p>' },
  { name: 'Link to page', md: '[[', html: '[[' },
  { name: 'Embed component or decision', md: '![[', html: '![[' },
];

// ---------- markdown <-> rich HTML ----------
const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
td.use(gfm);
// ponytail: no escaping so typed [[links]] and ![[embeds]] survive; literal * or _ in rich text may turn into formatting.
td.escape = (s) => s;
td.addRule('wikilink', { filter: (n) => n.nodeName === 'A' && n.classList.contains('wikilink'),
  replacement: (content, n) => `[[${n.dataset.link}${content && content !== n.dataset.link ? `|${content}` : ''}]]` });
td.addRule('embed', { filter: (n) => n.nodeName === 'DIV' && n.classList.contains('embed'), replacement: (c, n) => `\n\n![[${n.dataset.embed}]]\n\n` });
td.addRule('aiPlaceholder', { filter: (n) => n.nodeName === 'DIV' && n.classList.contains('ai-block'), replacement: (c, n) => `\n\n@@AGENCYAI${n.dataset.ai}@@\n\n` });
td.addRule('mermaid', { filter: (n) => n.nodeName === 'DIV' && n.classList.contains('mermaid-out'), replacement: (c, n) => `\n\n\`\`\`mermaid\n${n.dataset.src.trim()}\n\`\`\`\n\n` });
td.addRule('calloutTitle', { filter: (n) => n.classList?.contains('callout-title') || n.classList?.contains('ai-label'), replacement: () => '' });
td.addRule('callout', { filter: (n) => n.nodeName === 'BLOCKQUOTE' && n.dataset.callout,
  replacement: (content, n) => '\n\n' + `[!${n.dataset.callout}] ${content.trim()}`.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' });

function htmlToMd(root) {
  const md = td.turndown(root.cloneNode(true));
  // AI blocks are read-only in rich mode, so their original markdown is restored verbatim (lossless).
  return md.replace(/@@AGENCYAI(\d+)@@/g, (m, i) => `<!-- agency:ai -->\n${(st.aiTexts[+i] ?? '').trim()}\n<!-- /agency:ai -->`).replace(/\n{3,}/g, '\n\n') + '\n';
}

// ---------- CodeMirror pieces ----------
const aiLines = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = this.build(v); }
  update(u) { if (u.docChanged) this.decorations = this.build(u.view); }
  build(view) {
    const b = new RangeSetBuilder(), doc = view.state.doc;
    let inside = false;
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i), t = line.text.trim();
      if (t === '<!-- agency:ai -->') inside = true;
      if (inside) b.add(line.from, line.from, Decoration.line({ class: 'cm-ai' }));
      if (t === '<!-- /agency:ai -->') inside = false;
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--panel)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(64,196,196,.25) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
});

const slashSource = (ctx) => {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /^(\s*)\/([\w ]*)$/.exec(before);
  if (!m) return null;
  return {
    from: line.from + m[1].length,
    options: BLOCKS.map((b) => ({ label: '/' + b.name, displayLabel: b.name, type: 'text',
      apply: (view, c, from, to) => view.dispatch({ changes: { from, to, insert: b.md }, selection: { anchor: from + (b.cursor ?? b.md.length) } }) })),
  };
};

function linkTargets() {
  return [
    ...S.data.pages.filter((p) => !p.path.startsWith('_templates/') && !p.path.startsWith('components/')).map((p) => ({ label: p.name, detail: p.title !== p.name ? p.title : 'page' })),
    ...S.data.map.components.map((c) => ({ label: c.id, detail: `component · ${c.name}` })),
    ...S.data.decisions.map((d) => ({ label: d.id, detail: d.question.slice(0, 50) })),
  ];
}
const linkSource = (ctx) => {
  const m = ctx.matchBefore(/\[\[[^\]\n]*/);
  if (!m) return null;
  return { from: m.from + 2, options: linkTargets().map((t) => ({ ...t, type: 'variable', apply: `${t.label}]]` })), validFor: /^[^\]\n]*$/ };
};

// ---------- save / state ----------
const status = (s) => { const e = document.getElementById('saved'); if (e) e.textContent = s; };
function changed() {
  st.dirty = true; status('Editing…');
  clearTimeout(st.saveT); st.saveT = setTimeout(save, 700);
}
async function save() {
  clearTimeout(st.saveT);
  if (!st.dirty || !st.path) return;
  const text = stringifyFrontmatter(st.props, st.body);
  st.dirty = false; status('Saving…');
  const r = await api('/api/page', { method: 'PUT', body: JSON.stringify({ path: st.path, text }) });
  if (r.error) { st.dirty = true; return status(`Save failed: ${r.error}`); }
  st.saved = text; status('Saved');
}

// ---------- sidebar ----------
let filterText = '';
function sidebar() {
  const pages = S.data.pages;
  const q = filterText.toLowerCase();
  const shown = pages.filter((p) => !q || (p.title + p.path).toLowerCase().includes(q));
  const groups = new Map();
  for (const p of shown) {
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(p);
  }
  const order = [...groups.keys()].sort((a, b) => (a.startsWith('_') - b.startsWith('_')) || (a === '' ? -1 : b === '' ? 1 : a === 'components' ? -1 : b === 'components' ? 1 : a.localeCompare(b)));
  const tags = new Map();
  for (const p of pages) for (const t of [].concat(p.props.tags || [])) tags.set(t, (tags.get(t) || 0) + 1);
  const label = { '': 'Pages', components: 'Components', _templates: 'Templates' };
  sideEl.replaceChildren(
    h('div', { style: 'display:flex;gap:6px;margin-bottom:8px' },
      h('button.primary', { onclick: () => newPageDialog(), style: 'flex:1' }, '+ New page'),
      h('button', { onclick: () => go('#/wiki?table=') , title: 'Table of pages and their properties' }, 'Table')),
    h('input', { placeholder: 'Filter pages…', value: filterText, style: 'width:100%;margin-bottom:6px', oninput: (e) => { filterText = e.target.value; sidebar(); sideEl.querySelector('input').focus(); } }),
    h('ul.tree', ...order.map((dir) => h('li', h('div.folder', label[dir] ?? dir),
      h('ul', ...groups.get(dir).sort((a, b) => a.title.localeCompare(b.title)).map((p) => h('li',
        h(`div.item${p.path === st.path ? '.active' : ''}`, { onclick: () => go(`#/wiki/${p.path}`), title: p.path },
          p.title, p.props.locked ? h('span.small.muted', ' · locked') : ''))))))),
    tags.size ? h('div', h('div.folder', 'Tags'), h('div', { style: 'padding:4px 8px' }, ...[...tags].map(([t, n]) => h('span.tag', { onclick: () => go(`#/wiki?table=${encodeURIComponent(t)}`) }, `${t} ${n}`)))) : '');
}

// ---------- new page ----------
export function newPageDialog(name = '') {
  const templates = S.data.pages.filter((p) => p.path.startsWith('_templates/'));
  const folders = [...new Set(S.data.pages.map((p) => (p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '')).filter((f) => !f.startsWith('_')))];
  modal('New page', [
    h('label', 'Title', h('input', { name: 'title', value: name, required: true })),
    h('label', 'Folder', h('input', { name: 'folder', list: 'folders', placeholder: '(top level)' }), h('datalist#folders', ...folders.map((f) => h('option', { value: f })))),
    h('label', 'Template', h('select', { name: 'template' }, h('option', { value: '' }, 'Blank'), ...templates.map((t) => h('option', { value: t.path }, t.name)))),
  ], async ({ title, folder, template }) => {
    const slug = title.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-') || 'untitled';
    const path = `${folder ? folder.replace(/^\/|\/$/g, '') + '/' : ''}${slug}.md`;
    let text = `# ${title}\n\n`;
    if (template) text = (await api(`/api/page?path=${encodeURIComponent(template)}`)).text.replaceAll('{{title}}', title);
    await api('/api/page', { method: 'PUT', body: JSON.stringify({ path, text }) });
    go(`#/wiki/${path}`);
  }, 'Create');
}

// ---------- page view ----------
function propsGrid() {
  const grid = h('div.props');
  const paint = () => {
    grid.replaceChildren(...Object.entries(st.props).flatMap(([k, v]) => [
      h('span.k', k),
      h('input', { value: Array.isArray(v) ? v.join(', ') : String(v), 'aria-label': k,
        onchange: (e) => { const val = e.target.value.trim(); st.props[k] = Array.isArray(v) || k === 'tags' ? val.split(',').map((s) => s.trim()).filter(Boolean) : val === 'true' ? true : val === 'false' ? false : val; changed(); } }),
      h('button.ghost', { title: `Remove ${k}`, onclick: () => { delete st.props[k]; changed(); paint(); } }, '×')]),
      h('button.ghost.small', { style: 'grid-column:1/3;justify-self:start;padding:2px 0;color:var(--muted)', onclick: () => modal('Add property', [h('label', 'Name', h('input', { name: 'k', required: true, placeholder: 'status, owner, tags…' })), h('label', 'Value', h('input', { name: 'v' }))],
        ({ k, v }) => { k = k.trim().replace(/[^\w-]/g, ''); if (!k) return; st.props[k] = k === 'tags' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v; changed(); paint(); }, 'Add') }, '+ Add property'));
  };
  paint();
  return grid;
}

function onOwn(n) {
  st.body = takeOwnership(st.body, n);
  changed();
  if (st.cm) st.cm.dispatch({ changes: { from: 0, to: st.cm.state.doc.length, insert: st.body } });
  else renderEditor();
  toast('That text is yours now. The AI will read it but not rewrite it.');
}

function footer() {
  const box = h('div.md', { style: 'padding-top:0' });
  const out = [...new Set(wikilinks(st.body))];
  const compId = st.path.startsWith('components/') ? st.path.slice(11, -3) : null;
  const events = S.data.log.filter((e) => e.page === st.path || (compId && e.components?.includes(compId))).slice(-8).reverse();
  api(`/api/backlinks?path=${encodeURIComponent(st.path)}`).then((bl) => {
    box.replaceChildren(...[h('hr'),
      h('h3', `Linked from (${bl.length})`), bl.length ? h('ul.linklist', ...bl.map((b) => h('li', { onclick: () => go(`#/wiki/${b.path}`) }, b.title))) : h('p.muted.small', 'No pages link here yet.'),
      out.length ? [h('h3', 'Links to'), h('p', ...out.map((l) => h(`span.tag${resolve(l) ? '' : '.missing'}`, { onclick: () => go(resolve(l)?.type === 'decision' ? `#/decisions/${resolve(l).id}` : resolve(l) ? `#/wiki/${resolve(l).path}` : '#/wiki') }, l)))] : '',
      events.length ? [h('h3', 'Activity'), h('ul.linklist', ...events.map((e) => h('li', actorBadge(e.actor), ` ${e.kind} `, h('span.why', `${fmtDate(e.at)} ${e.reason || (e.files || []).join(', ')}`))))] : ''].flat());
  });
  return box;
}

let previewT;
function renderPreview() {
  if (!st.previewEl) return;
  st.previewEl.replaceChildren(renderMarkdown(st.body, { onOwn }), footer());
}

function renderEditor() {
  const wrap = st.editorWrap;
  st.cm?.destroy(); st.cm = null; st.previewEl = null;
  if (st.mode === 'source') {
    const host = h('div');
    st.previewEl = h('div.preview');
    wrap.replaceChildren(host, st.previewEl);
    st.cm = new EditorView({
      doc: st.body, parent: host,
      extensions: [minimalSetup, markdown(), EditorView.lineWrapping, aiLines, theme,
        autocompletion({ override: [slashSource, linkSource], icons: false }),
        EditorView.updateListener.of((u) => { if (u.docChanged) { st.body = u.state.doc.toString(); changed(); clearTimeout(previewT); previewT = setTimeout(renderPreview, 200); } })],
    });
    renderPreview();
  } else {
    st.aiTexts = segments(st.body).filter((s) => s.ai).map((s) => s.text);
    const r = renderMarkdown(st.body, { onOwn, rich: true });
    r.classList.add('rich');
    r.contentEditable = 'true';
    r.spellcheck = true;
    r.addEventListener('input', () => { st.body = htmlToMd(r); changed(); slashCheck(); });
    r.addEventListener('keydown', slashKeys, true);
    r.addEventListener('blur', () => setTimeout(hideSlash, 150));
    wrap.replaceChildren(h('div', r, footer()));
  }
}

async function openPage(path) {
  const p = await api(`/api/page?path=${encodeURIComponent(path)}`);
  if (p.missing) {
    st = { path: null };
    sidebar();
    return mainEl.replaceChildren(h('div.empty', h('h2', 'Page not found'), h('p', path), h('button.primary', { onclick: () => newPageDialog(path.replace(/\.md$/, '').split('/').pop()) }, 'Create it')));
  }
  const { props, body } = parseFrontmatter(p.text);
  st = { path: p.path, props, body, saved: p.text, dirty: false, mode: ls.get('agency.editorMode', 'source') };
  sidebar();
  const compId = p.path.startsWith('components/') ? p.path.slice(11, -3) : null;
  const modeBtn = (m, label, tip) => h(`button${st.mode === m ? '.primary' : ''}`, { title: tip, onclick: () => { if (st.mode === m) return; st.mode = m; ls.set('agency.editorMode', m); openPage(st.path); } }, label);
  st.editorWrap = h('div.editor-wrap');
  st.banner = h('div.banner', { hidden: true });
  mainEl.replaceChildren(h('div.col',
    h('div.toolbar',
      h('input.mono', { value: p.path, title: 'Rename / move', style: 'min-width:220px', onchange: async (e) => {
        await save();
        const to = e.target.value.trim().replace(/^\/+/, '');
        const r = await api('/api/page', { method: 'PUT', body: JSON.stringify({ path: to, from: st.path, text: stringifyFrontmatter(st.props, st.body) }) });
        if (r.error) return toast(r.error);
        go(`#/wiki/${r.path}`);
      } }),
      h('span', { style: 'display:inline-flex;gap:0' },
        modeBtn('source', 'Source + Preview', 'Obsidian-style: markdown on the left, rendered on the right'),
        modeBtn('rich', 'Rich', 'Notion-style: edit the rendered page directly')),
      h('label.small', { title: 'Locked pages are read-only for the AI' }, h('input', { type: 'checkbox', checked: !!st.props.locked, onchange: (e) => { st.props.locked = e.target.checked || undefined; changed(); } }), ' Lock from AI'),
      compId && h('button', { onclick: () => go(`#/map/${compId}`) }, 'On map'),
      h('span.grow'), h('span#saved.saved', 'Saved'),
      h('button.ghost', { title: 'Delete page', onclick: () => modal(`Delete ${st.path}?`, [h('p.muted', 'The file is removed from .agency/wiki. Git history keeps it if committed.')], async () => {
        await api(`/api/page?path=${encodeURIComponent(st.path)}`, { method: 'DELETE' }); st = {}; go('#/wiki');
      }, 'Delete') }, 'Delete')),
    h('div.page-head', propsGrid(), st.props.locked ? h('p.small.muted', 'Locked: the AI can read this page but not edit it.') : ''),
    st.banner, st.editorWrap));
  renderEditor();
}

// ---------- table view (Notion "database" lite) ----------
function tableView(tag) {
  st = { path: null };
  sidebar();
  const tags = [...new Set(S.data.pages.flatMap((p) => [].concat(p.props.tags || [])))];
  const pages = S.data.pages.filter((p) => !p.path.startsWith('_templates/') && (!tag || [].concat(p.props.tags || []).includes(tag)));
  const extra = JSON.parse(ls.get(`agency.cols.${tag}`, '[]'));
  const cols = [...new Set([...pages.flatMap((p) => Object.keys(p.props)), ...extra])].filter((k) => k !== 'title');
  const setProp = async (path, k, val) => {
    const p = await api(`/api/page?path=${encodeURIComponent(path)}`);
    const { props, body } = parseFrontmatter(p.text);
    props[k] = Array.isArray(props[k]) || k === 'tags' ? val.split(',').map((s) => s.trim()).filter(Boolean) : val;
    await api('/api/page', { method: 'PUT', body: JSON.stringify({ path, text: stringifyFrontmatter(props, body) }) });
  };
  mainEl.replaceChildren(h('div.col',
    h('div.toolbar', h('b', 'Table'),
      h('select', { onchange: (e) => go(`#/wiki?table=${encodeURIComponent(e.target.value)}`) }, h('option', { value: '' }, 'All pages'), ...tags.map((t) => h('option', { value: t, selected: t === tag }, `#${t}`))),
      h('span.grow'),
      h('button', { onclick: () => modal('Add column', [h('label', 'Property name', h('input', { name: 'k', required: true }))], ({ k }) => { ls.set(`agency.cols.${tag}`, JSON.stringify([...extra, k.trim()])); tableView(tag); }, 'Add') }, '+ Column')),
    h('div.scroll', h('table.grid',
      h('thead', h('tr', h('th', 'Page'), ...cols.map((c) => h('th', c)))),
      h('tbody', ...pages.map((p) => h('tr', h('td', h('a', { href: `#/wiki/${p.path}` }, p.title)),
        ...cols.map((c) => h('td', h('input', { value: [].concat(p.props[c] ?? '').join(', '), onchange: (e) => setProp(p.path, c, e.target.value) })))))))),
    pages.length ? '' : h('div.empty', 'No pages with this tag.')));
}

// ---------- rich-mode slash menu ----------
let slash = null;
function hideSlash() { slash?.el.remove(); slash = null; }
function slashCheck() {
  const sel = getSelection();
  const node = sel.anchorNode;
  if (!node || node.nodeType !== 3) return hideSlash();
  const before = node.textContent.slice(0, sel.anchorOffset);
  const m = /\/([\w ]*)$/.exec(before);
  const block = node.parentElement.closest('p,li,h1,h2,h3,div');
  if (!m || block?.textContent.trim() !== m[0].trim()) return hideSlash();
  const items = BLOCKS.filter((b) => b.name.toLowerCase().includes(m[1].toLowerCase()));
  if (!items.length) return hideSlash();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  hideSlash();
  slash = { items, sel: 0, node, start: sel.anchorOffset - m[0].length, end: sel.anchorOffset, el: h('div.slash') };
  slash.el.style.left = `${rect.left}px`; slash.el.style.top = `${rect.bottom + 6}px`;
  paintSlash();
  document.body.append(slash.el);
}
function paintSlash() {
  slash.el.replaceChildren(...slash.items.map((b, i) => h(`div${i === slash.sel ? '.sel' : ''}`, { onmousedown: (e) => { e.preventDefault(); slash.sel = i; applySlash(); } }, b.name)));
}
function applySlash() {
  const b = slash.items[slash.sel];
  const r = document.createRange();
  r.setStart(slash.node, slash.start); r.setEnd(slash.node, slash.end);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  hideSlash();
  // execCommand is deprecated but still the only way to get native undo for contenteditable inserts
  if (b.html === '[[' || b.html === '![[') document.execCommand('insertText', false, b.html);
  else document.execCommand('insertHTML', false, b.html);
}
function slashKeys(e) {
  if (!slash) return;
  if (e.key === 'ArrowDown') { slash.sel = (slash.sel + 1) % slash.items.length; paintSlash(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { slash.sel = (slash.sel - 1 + slash.items.length) % slash.items.length; paintSlash(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); applySlash(); }
  else if (e.key === 'Escape') { hideSlash(); e.preventDefault(); }
}

// ---------- tab lifecycle ----------
export async function mount(el, arg, query) {
  await save();
  container = el;
  sideEl = h('aside.side.left');
  mainEl = h('div.col');
  el.replaceChildren(h('div.split', sideEl, mainEl));
  if (query.has('table')) return tableView(query.get('table'));
  const target = arg || (S.data.pages.some((p) => p.path === 'index.md') ? 'index.md' : null);
  if (target) return openPage(target);
  st = { path: null };
  sidebar();
  mainEl.replaceChildren(h('div.empty', h('h2', 'Wiki'), h('p', 'Pages here are shared memory between you and your AI.'), h('button.primary', { onclick: () => newPageDialog() }, 'New page')));
}

// Live update: something changed on disk (AI via MCP, hooks, another editor).
export async function update() {
  if (!container) return;
  if (!st.path) { const q = new URLSearchParams(location.hash.split('?')[1] || ''); if (q.has('table')) tableView(q.get('table')); else sidebar(); return; }
  sidebar();
  const p = await api(`/api/page?path=${encodeURIComponent(st.path)}`);
  if (p.missing) return toast('This page was deleted or moved.');
  if (p.text === st.saved || p.text === stringifyFrontmatter(st.props, st.body)) { if (st.previewEl) renderPreview(); return; }
  const who = [...S.data.log].reverse().find((e) => e.page === st.path)?.actor === 'ai' ? 'the AI' : 'someone else';
  const load = () => {
    const { props, body } = parseFrontmatter(p.text);
    Object.assign(st, { props, body, saved: p.text, dirty: false });
    st.banner.hidden = true;
    openPage(st.path);
  };
  if (!st.dirty) { load(); toast(`Page updated by ${who}.`); return; }
  st.banner.hidden = false;
  st.banner.replaceChildren(h('span', `This page was changed by ${who} while you were editing.`), h('button', { onclick: load }, 'Load their version'),
    h('button', { onclick: () => { st.banner.hidden = true; st.dirty = true; save(); } }, 'Keep mine'));
}

export function unmount() { save(); st.cm?.destroy(); hideSlash(); container = null; }
