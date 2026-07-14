#!/usr/bin/env node
//
// sessions.js -- the browser-like manager CLI over agent-session.js. Open a
// session ("tab"), ask it, close it, or list them all. Each session is one
// ghostty window running one agent (claude | codex | shell), keyed by name.
//
//   node sessions.js open  <name> [--agent claude|codex|shell] [--cwd DIR] [--bin PATH] [-- <extra agent args>]
//   node sessions.js ask   <name> "prompt" [--expect STR] [--json]
//   node sessions.js close <name>
//   node sessions.js list  [--json]
//   node sessions.js close-all
//
// `ask` auto-opens the session if it isn't running (open-if-not-exist), so
// `node sessions.js ask ceo "hi"` just works. Extra agent flags (you run many
// claude/codex configs) go after `--`, e.g.
//   node sessions.js open opus --agent claude -- --model opus --mcp-config /x.json
// Run from a real GUI (Aqua) session.

'use strict';
const { SessionManager } = require('./agent-session.js');

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.args = argv.slice(i + 1); break; }   // extra agent args
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--expect') o.expect = argv[++i];
    else if (a === '--bin') o.bin = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--recipe') o.recipe = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--no-reuse') o.reuse = false;
    else o._.push(a);
  }
  return o;
}

function usage(code) {
  console.error([
    'usage:',
    '  sessions.js open  <name> [--agent claude|codex|shell] [--cwd DIR]',
    '  sessions.js ask   <name> "prompt" [--expect STR] [--json]',
    '  sessions.js close <name>',
    '  sessions.js list  [--json]',
    '  sessions.js close-all',
    '  sessions.js capture start  <name>',
    '  sessions.js capture stop   <name> [--out FILE]   # emit a recipe',
    '  sessions.js capture status <name>',
    '  sessions.js replay <name> [--recipe FILE] [--json]',
  ].join('\n'));
  process.exit(code);
}

const m = new SessionManager();
const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest);
const name = o._[0];

try {
  switch (cmd) {
    case 'open': {
      if (!name) usage(2);
      const s = m.open(name, { agent: o.agent, cwd: o.cwd, reuse: o.reuse, bin: o.bin, args: o.args });
      console.log(`opened '${name}' (${s.agentType}) pid=${s.pid || '(reused)'}`);
      break;
    }
    case 'ask': {
      if (!name) usage(2);
      const prompt = o._.slice(1).join(' ');
      if (!prompt) usage(2);
      // no --agent default here: the manager resolves it from the session's
      // meta.json (so `ask <name>` targets whatever agent it was opened as).
      const { answer, matched, reused } = m.ask(name, prompt,
        { agent: o.agent, cwd: o.cwd, expect: o.expect, bin: o.bin, args: o.args });
      if (o.json) console.log(JSON.stringify({ name, answer, matched, reused }, null, 2));
      else { console.log(`# ${name} reused=${reused} matched=${matched}`); console.log(answer); }
      process.exit(matched ? 0 : 1);
      break;
    }
    case 'close': {
      if (!name) usage(2);
      m.close(name);
      console.log(`closed '${name}'`);
      break;
    }
    case 'capture': {
      const sub = o._[0];         // start | stop | status
      const capName = o._[1];
      if (!sub || !capName) usage(2);
      if (sub === 'start') {
        m.captureStart(capName, { agent: o.agent });
        console.log(`capturing '${capName}' -- drive it (ask ...), then: capture stop ${capName}`);
      } else if (sub === 'status') {
        console.log(JSON.stringify(m.captureStatus(capName), null, 2));
      } else if (sub === 'stop') {
        const recipe = m.captureStop(capName);
        if (o.out) { require('fs').writeFileSync(o.out, JSON.stringify(recipe, null, 2)); console.error(`recipe -> ${o.out}`); }
        console.log(JSON.stringify(recipe, null, 2));
      } else usage(2);
      break;
    }
    case 'replay': {
      if (!name) usage(2);
      const recipe = o.recipe ? JSON.parse(require('fs').readFileSync(o.recipe, 'utf8')) : null;
      const report = m.replay(name, recipe, { cwd: o.cwd });
      if (o.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const r of report.results) console.log(`${r.ok ? '[ok]' : '[FAIL]'} ask: ${r.ask.slice(0, 50)} -> ${JSON.stringify(r.answer.slice(0, 40))}`);
        console.log(report.pass ? 'REPLAY: PASS' : 'REPLAY: FAIL');
      }
      process.exit(report.pass ? 0 : 1);
      break;
    }
    case 'list': {
      const rows = m.list();
      if (o.json) { console.log(JSON.stringify(rows, null, 2)); break; }
      if (!rows.length) { console.log('(no sessions)'); break; }
      for (const r of rows) {
        console.log(`${r.live ? '●' : '○'} ${r.name.padEnd(16)} ${String(r.agent).padEnd(8)} ${r.live ? 'live' : 'dead'}${r.pid ? ' pid=' + r.pid : ''}`);
      }
      break;
    }
    case 'close-all': {
      const n = m.list().length;
      m.closeAll();
      console.log(`closed ${n} session(s)`);
      break;
    }
    default: usage(cmd ? 2 : 0);
  }
} catch (e) {
  console.error('sessions: FAIL -- ' + e.message);
  process.exit(1);
}
