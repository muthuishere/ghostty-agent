#!/usr/bin/env node
//
// drive-claude.js -- the ghostty-agent skill's reusable capability: drive a real
// interactive `claude` session two-way from JS. Spawn (or REUSE) a ghostty
// window running claude, ask it anything, and get the model's answer BACK as a
// value so the caller can decide/act on it.
//
//   const { driveClaude } = require('./drive-claude.js');
//   const { answer, surface, reused } = driveClaude({ prompt: 'What is 21+21?' });
//   if (answer.includes('42')) { ...decide... }
//
// Or hold a session open across turns:
//   const s = new ClaudeSession({ name: 'ceo' });
//   s.ensure();                     // start if not running, else reuse
//   const a1 = s.ask('summarise X'); // -> { answer, surface, matched }
//   const a2 = s.ask('now do Y');    // same window, no re-spawn
//
// Design (why it's reliable -- see the skill SKILL.md):
//   * clean-env launch: claude runs as ghostty's OWN PTY process via --command,
//     bypassing the login shell/tmux that would misroute injected input.
//   * text->Enter separation: `prompt` types, waits, THEN presses Enter, so the
//     Claude/Ink TUI submits instead of treating text+CR as a paste.
//   * --window-save-state=never: macOS state-restoration otherwise reopens a
//     SECOND watched surface that races the reader ("claude never booted" flake).
//   * "start if not exist": a session is keyed by a STABLE spool dir under
//     ~/.config/ghostty-agent/sessions/<name>/, so a probe tells us whether a
//     live watcher is already there to reuse.
//
// All protocol I/O goes through the sendkeys.js CLI (single source of truth).
// Pure Node, no deps. Run from a REAL GUI (Aqua) session -- ghostty needs a
// WindowServer to open a window.
//
// CLI:  node drive-claude.js [--name N] [--cwd DIR] [--expect STR]
//                            [--json] [--close] [--no-reuse] "the prompt"

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch (_) { return path.resolve(__dirname, '../../../..'); }
}
function whichSync(bin) {
  // `command -v` in a plain sh, bin passed as $0 (no shell:true -> no arg-escape
  // deprecation, no injection).
  const r = spawnSync('sh', ['-c', 'command -v "$0"', bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function sleep(ms) { spawnSync('sleep', [String(ms / 1000)]); }

const ROOT = repoRoot();
const SENDKEYS = path.join(ROOT, 'sendkeys.js');
const SESSIONS_HOME = process.env.GHOSTTY_AGENT_HOME
  || path.join(os.homedir(), '.config', 'ghostty-agent', 'sessions');

// Pull the model's LATEST reply out of the Claude Code TUI. Replies are marked
// with the "⏺" bullet; on a reused session the surface still holds older turns,
// so return only the LAST bullet block (the answer to the prompt we just sent).
// Falls back to the surface tail if no bullet is present.
function extractAnswer(surface) {
  const lines = (surface || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith('⏺')) last = i;
  if (last === -1) return lines.filter((l) => l.trim()).slice(-3).join('\n').trim();
  const out = [lines[last].trim().replace(/^⏺\s*/, '')];
  // Include immediately-following continuation lines -- the body of a multi-line
  // answer is INDENTED under the bullet. Anything flush-left (the input prompt,
  // a "✻ Worked"/"◐"/box-drawing status line, another bullet) ends the answer.
  for (let i = last + 1; i < lines.length; i++) {
    if (!/^\s+\S/.test(lines[i])) break;   // must be indented, non-empty
    out.push(lines[i].trim());
  }
  return out.join('\n').trim();
}

class ClaudeSession {
  // opts: { name='default', cwd, claudeBin, ghosttyBin, enterDelayMs, reuse=true }
  constructor(opts = {}) {
    this.name = opts.name || 'default';
    this.dir = path.join(SESSIONS_HOME, this.name);
    this.spool = path.join(this.dir, 'spool');
    this.resp = path.join(this.dir, 'responses');
    this.log = path.join(this.dir, 'ghostty.log');
    this.pidfile = path.join(this.dir, 'ghostty.pid');
    this.cwd = opts.cwd || path.join(this.dir, 'cwd');
    this.reuse = opts.reuse !== false;
    this.enterDelayMs = opts.enterDelayMs;
    this.ghosttyBin = opts.ghosttyBin
      || path.join(ROOT, 'zig-out/Ghostty.app/Contents/MacOS/ghostty');
    this.claudeBin = opts.claudeBin || process.env.CLAUDE_BIN
      || whichSync('claude') || '/Users/muthuishere/.local/bin/claude';
    this.pid = 0;
  }

  // Run the sendkeys.js CLI against this session's spool; tolerant parse.
  sk(args, id) {
    const full = ['--dir', this.spool, '--resp-dir', this.resp];
    if (id) full.push('--id', id);
    const r = spawnSync('node', [SENDKEYS, ...full, ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try { return JSON.parse((r.stdout || '').trim()); } catch (_) { return {}; }
  }

  read(lines = 40) { return (this.sk(['read', '--lines', String(lines)]).surface) || ''; }

  // Is a live watcher already answering on this session's spool?
  isLive() {
    const probe = this.sk(['read', '--lines', '1'], `__probe_${Date.now()}__`);
    return probe && probe.ok === true;
  }

  _mkdirs() { for (const d of [this.spool, this.resp, this.cwd]) fs.mkdirSync(d, { recursive: true }); }

  _launch() {
    const logfd = fs.openSync(this.log, 'a');
    const command = `/bin/bash --noprofile --norc -c 'cd "${this.cwd}" && `
      + `exec "${this.claudeBin}" --dangerously-skip-permissions'`;
    const env = { ...process.env,
      GHOSTTY_SENDKEYS_DIR: this.spool,
      GHOSTTY_SENDKEYS_RESP_DIR: this.resp,
      GHOSTTY_LOG: 'info' };
    if (this.enterDelayMs != null) env.GHOSTTY_SENDKEYS_ENTER_DELAY_MS = String(this.enterDelayMs);
    const child = spawn(this.ghosttyBin, ['--window-save-state=never', `--command=${command}`],
      { env, stdio: ['ignore', logfd, logfd], detached: true });
    child.unref();
    this.pid = child.pid;
    fs.writeFileSync(this.pidfile, String(this.pid));
  }

  // Accept the folder-trust dialog if it's up, then block until claude has
  // booted (the "bypass permissions" status line). Returns true if ready.
  _acceptTrustAndBoot() {
    const trust = this.sk(['waitfor', '--contains', 'trust', '--timeout-ms', '8000']);
    if (trust && trust.matched) this.sk(['send', 'KEY:enter']);
    for (let i = 0; i < 3; i++) {
      const boot = this.sk(['waitfor', '--contains', 'bypass permissions',
        '--timeout-ms', '40000', '--settle-ms', '1500']);
      if (boot && boot.matched) return true;
    }
    return false;
  }

  // Start if not running, else reuse. Throws with a clear diagnosis on failure.
  // Returns { reused: boolean }.
  ensure() {
    this._mkdirs();
    if (this.reuse && this.isLive()) {
      // A watcher is already here. Make sure it's actually a booted claude
      // (a reused window could still be parked on the trust dialog).
      const surface = this.read(40);
      if (surface.includes('bypass permissions')) return { reused: true };
      if (!this._acceptTrustAndBoot()) throw new Error('reused session never reached a booted claude');
      return { reused: true };
    }
    // Nothing live -> launch a fresh one, retrying for a live watcher.
    for (let attempt = 1; attempt <= 3; attempt++) {
      this._launch();
      if (this.isLive()) {
        if (!this._acceptTrustAndBoot()) throw new Error('claude never booted after launch');
        return { reused: false };
      }
      this.kill();
      sleep(2000);
    }
    const mgr = (spawnSync('launchctl', ['managername'], { encoding: 'utf8' }).stdout || '').trim();
    throw new Error(
      'ghostty never created a WATCHED surface -- almost always NO GUI/WindowServer '
      + `(Aqua) session. launchctl managername=${mgr} TMUX=${process.env.TMUX || '<none>'}. `
      + 'Run from a real GUI terminal, not a detached tmux/ssh/background context.');
  }

  // Ask a prompt and return { answer, surface, matched }.
  //   opts.expect   -- substring to wait for (server-side waitfor). Fastest,
  //                    use when you know a marker in the answer.
  //   otherwise     -- wait until the surface changes then settles (model idle).
  ask(prompt, opts = {}) {
    const timeoutMs = opts.timeoutMs || 90000;
    const before = this.read(200);
    this.sk(['prompt', prompt]);
    if (opts.expect) {
      const r = this.sk(['waitfor', '--contains', opts.expect, '--timeout-ms', String(timeoutMs)]);
      const surface = (r && r.surface) || this.read(200);
      return { answer: extractAnswer(surface), surface, matched: !!(r && r.matched) };
    }
    // Generic: wait for output to appear (surface != baseline) then go idle.
    const settleMs = opts.settleMs || 1500;
    const start = Date.now();
    let last = before, lastChange = Date.now(), changed = false;
    while (Date.now() - start < timeoutMs) {
      const cur = this.read(200);
      if (cur !== last) { last = cur; lastChange = Date.now(); if (cur !== before) changed = true; }
      else if (changed && Date.now() - lastChange >= settleMs) break;
      sleep(250);
    }
    return { answer: extractAnswer(last), surface: last, matched: changed };
  }

  kill() {
    let pid = this.pid;
    if (!pid) { try { pid = parseInt(fs.readFileSync(this.pidfile, 'utf8'), 10); } catch (_) {} }
    if (pid) { try { process.kill(pid); } catch (_) {} }
    this.pid = 0;
    try { fs.unlinkSync(this.pidfile); } catch (_) {}
  }
}

// One-shot convenience: ensure a session, ask once, return the answer. Leaves
// the session RUNNING for reuse unless close:true.
function driveClaude(opts = {}) {
  const s = new ClaudeSession(opts);
  const { reused } = s.ensure();
  const r = s.ask(opts.prompt, opts);
  if (opts.close) s.kill();
  return { ...r, reused, session: s };
}

module.exports = { ClaudeSession, driveClaude, extractAnswer };

// --- CLI ---
if (require.main === module) {
  const argv = process.argv.slice(2);
  const o = { name: 'default', json: false, close: false, reuse: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') o.name = argv[++i];
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--expect') o.expect = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--close') o.close = true;
    else if (a === '--no-reuse') o.reuse = false;
    else rest.push(a);
  }
  o.prompt = rest.join(' ');
  if (!o.prompt) { console.error('usage: drive-claude.js [--name N] [--cwd DIR] [--expect STR] [--json] [--close] [--no-reuse] "prompt"'); process.exit(2); }
  try {
    const { answer, surface, matched, reused } = driveClaude(o);
    if (o.json) console.log(JSON.stringify({ answer, matched, reused, surface }, null, 2));
    else { console.log(`# reused=${reused} matched=${matched}`); console.log(answer); }
    process.exit(matched ? 0 : 1);
  } catch (e) {
    console.error('drive-claude: FAIL -- ' + e.message);
    process.exit(1);
  }
}
