#!/usr/bin/env node
//
// drive-claude.js -- convenience wrapper around agent-session.js bound to the
// `claude` agent. The generic engine (spawn/reuse/ask/close, all agents, the
// SessionManager) lives in agent-session.js; this is the claude-flavoured API +
// CLI. See agent-session.js and the skill SKILL.md.
//
//   const { driveClaude, ClaudeSession } = require('./drive-claude.js');
//   const { answer } = driveClaude({ prompt: 'What is 21+21?', expect: '42' });
//   // extra claude flags (many-configs): args appended on top of the safety flags
//   driveClaude({ name:'opus', prompt:'hi', args:['--model','opus'] });
//
// CLI:  node drive-claude.js [--name N] [--cwd DIR] [--expect STR] [--bin PATH]
//                            [--json] [--close] [--no-reuse] "the prompt" [-- <extra claude args>]
//   e.g. node drive-claude.js --name opus "hi" -- --model opus --mcp-config /x.json

'use strict';
const { AgentSession, makeExtractAnswer } = require('./agent-session.js');

class ClaudeSession extends AgentSession {
  constructor(opts = {}) { super({ ...opts, agent: 'claude' }); }
}
function driveClaude(opts = {}) {
  const s = new ClaudeSession(opts);
  const { reused } = s.open();
  const r = s.ask(opts.prompt, opts);
  if (opts.close) s.close();
  return { ...r, reused, session: s };
}
const extractAnswer = makeExtractAnswer('⏺');   // claude's reply bullet

module.exports = { ClaudeSession, driveClaude, extractAnswer };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const o = { json: false, close: false, reuse: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.args = argv.slice(i + 1); break; }   // everything after -- => extra claude args
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--expect') o.expect = argv[++i];
    else if (a === '--bin') o.bin = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--close') o.close = true;
    else if (a === '--no-reuse') o.reuse = false;
    else rest.push(a);
  }
  o.prompt = rest.join(' ');
  if (!o.prompt) { console.error('usage: drive-claude.js [--name N] [--cwd DIR] [--expect STR] [--bin PATH] [--json] [--close] [--no-reuse] "prompt" [-- <extra claude args>]'); process.exit(2); }
  try {
    const { answer, matched, reused } = driveClaude(o);
    if (o.json) console.log(JSON.stringify({ answer, matched, reused }, null, 2));
    else { console.log(`# reused=${reused} matched=${matched}`); console.log(answer); }
    process.exit(matched ? 0 : 1);
  } catch (e) { console.error('drive-claude: FAIL -- ' + e.message); process.exit(1); }
}
