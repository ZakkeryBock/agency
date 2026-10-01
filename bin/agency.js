#!/usr/bin/env node
import * as S from '../src/store.js';

const [cmd, sub, ...rest] = process.argv.slice(2);

const HELP = `agency — shared project map, wiki and decisions for you and your AI

  agency init                 set up .agency/ + Claude Code (MCP, hooks, skill), AGENTS.md, git hook
  agency serve [--port N]     open the GUI (127.0.0.1 only)
  agency check                coverage: unmapped files, dead globs, stale components
  agency context "<task>"     print the briefing an AI would get
  agency map                  how to (re)build the map with your AI
  agency statusline-install   add the [AGENCY] badge to Claude Code's statusline
  agency mcp | hook <name> | statusline   (called by Claude Code, not you)`;

const need = () => S.findRoot() || (console.error('No .agency/ here. Run `agency init` first.'), process.exit(1));

switch (cmd) {
  case 'init': {
    const { init } = await import('../src/init.js');
    const created = init();
    console.log(`Agency initialized (${created.length} files).
Next:
  1. Restart Claude Code in this folder and approve the "agency" MCP server.
  2. Ask Claude: "map this project with agency".
  3. agency serve  → open the map.
  4. agency statusline-install  → see the [AGENCY] badge.`);
    break;
  }
  case 'serve': {
    const { serve } = await import('../src/server.js');
    const i = process.argv.indexOf('--port');
    serve(need(), i > 0 ? +process.argv[i + 1] : 4141, !process.argv.includes('--no-open'));
    break;
  }
  case 'mcp': (await import('../src/mcp.js')).runMcp(); break;
  case 'hook': {
    const H = await import('../src/hooks.js');
    const fn = { 'session-start': H.sessionStart, 'post-tool': H.postTool, stop: H.stop, 'post-commit': H.postCommit }[sub];
    // hooks must never break the user's session
    try { fn?.(); } catch (e) { console.error(`agency hook ${sub}: ${e.message}`); }
    break;
  }
  case 'statusline': try { (await import('../src/hooks.js')).statusline(); } catch {} break;
  case 'statusline-install': console.log((await import('../src/init.js')).installStatusline()); break;
  case 'check': {
    const root = need();
    const cov = S.coverage(root);
    const st = S.loadState(root);
    console.log(`${cov.total} files, ${cov.unmapped.length} unmapped, ${cov.multi.length} in multiple components, ${cov.dead.length} dead globs, ${Object.keys(st.stale).length} stale`);
    for (const f of cov.unmapped.slice(0, 30)) console.log(`  unmapped  ${f}`);
    for (const m of cov.multi.slice(0, 30)) console.log(`  multi     ${m.file} → ${m.components.join(', ')}`);
    for (const d of cov.dead) console.log(`  dead      ${d} (globs match nothing)`);
    process.exitCode = cov.unmapped.length || cov.dead.length ? 1 : 0;
    break;
  }
  case 'context': {
    const r = S.context(need(), [sub, ...rest].join(' '));
    console.log(r.briefing + `\n\n(~${r.tokens} tokens)`);
    break;
  }
  case 'map':
    console.log('Mapping is done by your AI so components get human names. In Claude Code say:\n  "map this project with agency"\nOther agents read AGENTS.md for the same instructions.');
    break;
  default: console.log(HELP);
}
