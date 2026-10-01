// Shared by the server (store.js) and the browser GUI. No Node imports here.

// Frontmatter is flat: `key: value` or `key: [a, b]`. ponytail: not full YAML; nested data lives in map.json.
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { props: {}, body: text };
  const props = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === 'true' || v === 'false') v = v === 'true';
    props[kv[1]] = v;
  }
  return { props, body: text.slice(m[0].length) };
}

export function stringifyFrontmatter(props, body) {
  const keys = Object.keys(props).filter((k) => props[k] !== undefined && props[k] !== '' && !(Array.isArray(props[k]) && !props[k].length));
  if (!keys.length) return body;
  const lines = keys.map((k) => `${k}: ${Array.isArray(props[k]) ? `[${props[k].join(', ')}]` : props[k]}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// AI-owned blocks. Everything outside them belongs to the user.
export const AI_OPEN = '<!-- agency:ai -->', AI_CLOSE = '<!-- /agency:ai -->';
export const AI_BLOCK_RE = /<!-- agency:ai -->\r?\n?([\s\S]*?)\r?\n?<!-- \/agency:ai -->/g;

// Split body into [{ai: bool, text}] segments, in order.
export function segments(body) {
  const out = [];
  let last = 0;
  for (const m of body.matchAll(AI_BLOCK_RE)) {
    if (m.index > last) out.push({ ai: false, text: body.slice(last, m.index) });
    out.push({ ai: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ ai: false, text: body.slice(last) });
  return out;
}

export const joinSegments = (segs) => segs.map((s) => (s.ai ? `${AI_OPEN}\n${s.text.trim()}\n${AI_CLOSE}` : s.text)).join('');

// Remove the markers of the nth AI block: the user now owns that text.
export function takeOwnership(body, n) {
  let i = -1;
  return body.replace(AI_BLOCK_RE, (all, inner) => (++i === n ? inner : all));
}

export const userOwnedText = (body) => body.replace(AI_BLOCK_RE, '').trim();

export const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
export const wikilinks = (body) => [...body.matchAll(WIKILINK_RE)].map((m) => m[2].trim());

// Pages tagged rule/convention go into every AI briefing. Templates never count.
export const isRule = (pg) => !pg.path.startsWith('_templates/') && [].concat(pg.props.tags || []).some((t) => /^#?(rule|convention)$/.test(t));
