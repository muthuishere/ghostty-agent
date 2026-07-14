#!/usr/bin/env node
//
// prove-twoway.js -- end-to-end proof that the two-way (v2) sendkeys protocol
// reliably DRIVES a real interactive `claude` session from an external process:
// type, wait on observed surface state, and confirm the model actually answered.
// This is the reliable visible-spawn primitive the fleet needs to replace blind
// `tmux send-keys` for CEO wakes. Pure Node -- no shell wrapper (the whole
// ghostty-agent tooling is JS: this drives the sendkeys.js CLI directly).
//
// TWO root-cause fixes make this reliable (see SENDKEYS_SPEC.md "The Enter bug"):
//   1. text->Enter separation: a TUI (Claude Code/Ink) treats a fast text burst
//      + trailing CR as a paste, swallowing the CR as a literal newline instead
//      of submitting. `prompt` injects the text, waits GHOSTTY_SENDKEYS_ENTER_
//      DELAY_MS (default 250ms), THEN injects Enter as a distinct keypress.
//   2. clean environment: the operator's login shell auto-attaches tmux (+direnv),
//      producing a ghostty->zsh->tmux->claude stack that misroutes injected input
//      to the shell. We launch claude DIRECTLY as ghostty's PTY process via
//      `--command`, bypassing the login shell entirely.
//   plus: --window-save-state=never so macOS state-restoration doesn't reopen a
//      SECOND watched surface that races the reader (the "claude never booted"
//      flake; see the skill doc).
//
// Acceptance (owner): prompt "What is 21 plus 21? ..." then waitfor "42" must
// match -- "42" is NOT in the prompt, so a match can only be the model's output,
// proving Enter submitted in the TUI.
//
// Usage: node .claude/skills/ghostty-sendkeys/scripts/prove-twoway.js
//        SKIP_BUILD=1 node ...prove-twoway.js   (skip build; used by the 3x wrapper)
// Exit:  0 = PASS, non-zero = FAIL.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');

// --- Repo root: this script lives inside the skill; resolve the real top-level.
let ROOT;
try {
  ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'],
    { cwd: __dirname, encoding: 'utf8' }).trim();
} catch (_) {
  ROOT = path.resolve(__dirname, '../../../..');
}
const SENDKEYS = path.join(ROOT, 'sendkeys.js');
const CLAUDE = process.env.CLAUDE_BIN
  || whichSync('claude')
  || '/Users/muthuishere/.local/bin/claude';

function whichSync(bin) {
  const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fail(msg, extra) {
  console.log(`PROVE-TWOWAY: FAIL  (${msg})`);
  if (extra) console.log(extra);
  cleanup();
  process.exit(1);
}

// --- Build first, then run THAT EXACT binary (never test a stale install: a
//     binary without the two-way Zig code silently TYPES a WAITFOR as text). ---
let ZIG = process.env.ZIG || '/opt/homebrew/opt/zig@0.15/bin/zig';
if (!fs.existsSync(ZIG)) ZIG = 'zig';
if (process.env.SKIP_BUILD !== '1') {
  console.log(`--- building the fork (${ZIG} build) ---`);
  const b = spawnSync(ZIG, ['build'], { cwd: ROOT, stdio: 'inherit' });
  if (b.status !== 0) fail('zig build failed');
}
const GH = path.join(ROOT, 'zig-out/Ghostty.app/Contents/MacOS/ghostty');
try { fs.accessSync(GH, fs.constants.X_OK); }
catch (_) { fail(`no binary at ${GH} -- run zig build`); }
// Fail loudly if the binary predates the two-way source (stale build).
if (fs.statSync(path.join(ROOT, 'src/Surface.zig')).mtimeMs > fs.statSync(GH).mtimeMs) {
  fail('binary is OLDER than src/Surface.zig -- stale build');
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-twoway.'));
const SPOOL = path.join(WORK, 'spool');
const RESP = path.join(WORK, 'responses');
const LOG = path.join(WORK, 'ghostty.log');
// Clean, empty cwd: no repo CLAUDE.md to load, so claude answers tersely/fast
// (and exercises the folder-trust dialog on a fresh dir).
const CLAUDE_CWD = path.join(WORK, 'cwd');
for (const d of [SPOOL, RESP, CLAUDE_CWD]) fs.mkdirSync(d, { recursive: true });

console.log('=== prove-twoway.js ===');
console.log(`ghostty:  ${GH}`);
console.log(`claude:   ${CLAUDE}`);
console.log(`workdir:  ${WORK}\n`);

// Run the sendkeys.js CLI and return parsed JSON (tolerant: an empty/partial
// or timed-out response must never throw -- return {} and let callers decide).
function sk(args, id) {
  const full = ['--dir', SPOOL, '--resp-dir', RESP];
  if (id) full.push('--id', id);
  const r = spawnSync('node', [SENDKEYS, ...full, ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '').trim();
  try { return JSON.parse(out); } catch (_) { return {}; }
}
const isMatched = (res) => res && res.matched === true;
function summary(res) {
  if (res && ('matched' in res))
    console.log(`  matched=${res.matched} reason=${res.reason} elapsed_ms=${res.elapsed_ms}`);
  else console.log('  (no/parse-fail response)');
}
function tail(res, n) {
  const lines = ((res && res.surface) || '').split('\n').filter((l) => l.trim());
  console.log(lines.slice(-n).join('\n'));
}

let GPID = 0;
function cleanup() { if (GPID) { try { process.kill(GPID); } catch (_) {} GPID = 0; } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// Launch the fork running claude DIRECTLY (clean env, single surface), then
// VERIFY a watcher is live by probing with a READ. No watcher -> almost always
// no GUI/WindowServer (Aqua) session (detached tmux / ssh / background). Retry a
// few times, then FAIL LOUDLY with that diagnosis instead of hanging.
function launchAndVerify() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`--- launch attempt ${attempt} ---`);
    const logfd = fs.openSync(LOG, 'a');
    const command = `/bin/bash --noprofile --norc -c 'cd "${CLAUDE_CWD}" && `
      + `exec "${CLAUDE}" --dangerously-skip-permissions'`;
    const child = spawn(GH, ['--window-save-state=never', `--command=${command}`], {
      env: { ...process.env,
        GHOSTTY_SENDKEYS_DIR: SPOOL,
        GHOSTTY_SENDKEYS_RESP_DIR: RESP,
        GHOSTTY_LOG: 'info' },
      stdio: ['ignore', logfd, logfd],
      detached: true,
    });
    child.unref();
    GPID = child.pid;
    console.log(`ghostty pid: ${GPID} -- probing for a live watcher...`);
    const probe = sk(['read', '--lines', '1'], `__probe_${attempt}__`);
    if (probe && probe.ok === true) { console.log('watcher is live (probe answered).'); return true; }
    console.log(`no watcher response on attempt ${attempt}; killing and retrying.`);
    cleanup();
    spawnSync('sleep', ['2']);
  }
  return false;
}

if (!launchAndVerify()) {
  console.log('\nPROVE-TWOWAY: FAIL  (ghostty never created a WATCHED surface)');
  console.log('  No READ/WAITFOR response is ever written -- almost always the launch has');
  console.log('  NO GUI / WindowServer (Aqua) session and cannot open a window.');
  const mgr = spawnSync('launchctl', ['managername'], { encoding: 'utf8' }).stdout || '';
  console.log(`  launchctl managername = ${mgr.trim()}`);
  console.log(`  TMUX = ${process.env.TMUX || '<none>'}`);
  console.log('  >>> Run this from a REAL GUI terminal (an Aqua login session), NOT from a');
  console.log('      detached tmux / ssh / background/automation context.');
  console.log('  (The two-way protocol itself is unit-tested headless: node --test sendkeys.test.js)');
  process.exit(1);
}

// --- [1] handle the trust dialog if it appears ---
console.log('\n--- [1] wait for the trust dialog (if any) ---');
const trust = sk(['waitfor', '--contains', 'trust', '--timeout-ms', '8000']);
if (isMatched(trust)) {
  console.log('>>> trust dialog present -> KEY:enter to accept');
  sk(['send', 'KEY:enter']);   // send = stage + push (a bare `key` only stages)
} else {
  console.log('>>> no trust dialog (already trusted)');
}

// --- [2] wait for claude to finish booting (retry for robustness) ---
console.log('\n--- [2] wait for claude boot (bypass permissions banner) ---');
let boot = {};
for (let attempt = 1; attempt <= 3; attempt++) {
  boot = sk(['waitfor', '--contains', 'bypass permissions', '--timeout-ms', '40000', '--settle-ms', '1500']);
  console.log(`  attempt ${attempt}:`); summary(boot);
  if (isMatched(boot)) break;
}
if (!isMatched(boot)) {
  let logtail = '';
  try { logtail = fs.readFileSync(LOG, 'utf8').split('\n').slice(-20).join('\n'); } catch (_) {}
  fail('claude never booted', `--- ghostty log tail ---\n${logtail}`);
}

console.log('\n--- [2b] surface snapshot (claude ready) ---');
tail(sk(['read', '--lines', '6']), 6);

// --- [3] ask, then wait for the model's answer (ACCEPTANCE) ---
console.log("\n--- [3] PROMPT the model (answer '42' is NOT in the prompt) ---");
sk(['prompt', 'What is 21 plus 21? Reply with only the number and nothing else.']);

console.log("\n--- [4] WAITFOR the model's answer '42' (acceptance) ---");
const res = sk(['waitfor', '--contains', '42', '--timeout-ms', '90000']);
summary(res);
console.log('--- surface tail ---'); tail(res, 8);

// --- [5] full scrollback + screenshot into the report ---
console.log('\n--- [5] gettext --all (full scrollback) tail ---');
tail(sk(['gettext', '--all']), 6);

console.log('\n--- [6] screenshot the result ---');
const SHOT = path.join(ROOT, 'twoway-notes/prove-twoway-result.png');
fs.mkdirSync(path.dirname(SHOT), { recursive: true });
sk(['screenshot', SHOT, '--pid', String(GPID)]);
if (fs.existsSync(SHOT)) console.log(`screenshot: ${SHOT} (${fs.statSync(SHOT).size} bytes)`);

console.log('');
if (isMatched(res)) {
  console.log('PROVE-TWOWAY: PASS  (drove a claude session end-to-end; Enter submitted in the TUI)');
  cleanup();
  process.exit(0);
} else {
  fail('never observed the model\'s answer');
}
