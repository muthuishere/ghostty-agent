#!/usr/bin/env node
//
// drive-codex.js -- convenience wrapper around agent-session.js bound to the
// `codex` agent (OpenAI Codex CLI). Same shape as drive-claude.js; the generic
// engine lives in agent-session.js. See the skill SKILL.md.
//
//   const { driveCodex, CodexSession } = require('./drive-codex.js');
//   const { answer } = driveCodex({ prompt: 'What is 21+21? Reply with only the number.', expect: '42' });
//
// Codex is launched with --dangerously-bypass-approvals-and-sandbox
// --dangerously-bypass-hook-trust; boot navigates its startup gates (update
// nag -> Skip, directory-trust -> Yes) to the composer. Replies are the "•"
// bullet lines.
//
// CLI:  node drive-codex.js [--name N] [--cwd DIR] [--expect STR] [--bin PATH]
//                           [--json] [--close] [--no-reuse] "the prompt" [-- <extra codex args>]
//   e.g. node drive-codex.js --name gpt "hi" -- --model gpt-5.5 -c foo.bar=1

'use strict';
const { AgentSession, makeExtractAnswer } = require('./agent-session.js');

class CodexSession extends AgentSession {
  constructor(opts = {}) { super({ ...opts, agent: 'codex' }); }
}
function driveCodex(opts = {}) {
  const s = new CodexSession(opts);
  const { reused } = s.open();
  const r = s.ask(opts.prompt, opts);
  if (opts.close) s.close();
  return { ...r, reused, session: s };
}
const extractAnswer = makeExtractAnswer('•');   // codex's reply bullet

module.exports = { CodexSession, driveCodex, extractAnswer };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const o = { json: false, close: false, reuse: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.args = argv.slice(i + 1); break; }   // everything after -- => extra codex args
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
  if (!o.prompt) { console.error('usage: drive-codex.js [--name N] [--cwd DIR] [--expect STR] [--bin PATH] [--json] [--close] [--no-reuse] "prompt" [-- <extra codex args>]'); process.exit(2); }
  try {
    const { answer, matched, reused } = driveCodex(o);
    if (o.json) console.log(JSON.stringify({ answer, matched, reused }, null, 2));
    else { console.log(`# reused=${reused} matched=${matched}`); console.log(answer); }
    process.exit(matched ? 0 : 1);
  } catch (e) { console.error('drive-codex: FAIL -- ' + e.message); process.exit(1); }
}
