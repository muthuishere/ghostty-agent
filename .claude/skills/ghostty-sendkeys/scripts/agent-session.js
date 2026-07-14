#!/usr/bin/env node
//
// agent-session.js -- the ghostty-agent skill's core: drive interactive terminal
// agents (claude, codex, or a plain shell) two-way, and MANAGE many of them like
// browser tabs -- open (if not exists), ask, close, list.
//
// Each session is one ghostty WINDOW running one agent, keyed by a stable name
// under ~/.config/ghostty-agent/sessions/<name>/ (its own spool + resp dir).
// One window per session on purpose: multiple surfaces in one process would
// share one spool and race the reader (the state-restoration flake we fix with
// --window-save-state=never). So "tabs" = named windows you open/close/switch.
//
//   const { SessionManager } = require('./agent-session.js');
//   const m = new SessionManager();
//   m.open('ceo', { agent: 'claude' });        // start if not running, else reuse
//   const { answer } = m.ask('ceo', 'What is 21+21?', { expect: '42' });
//   m.open('rev', { agent: 'codex' });          // a second "tab"
//   m.list();                                   // [{name, agent, live, pid}, ...]
//   m.close('ceo');
//
// All protocol I/O goes through the sendkeys.js CLI (single source of truth).
// Pure Node, no deps. Run from a REAL GUI (Aqua) session -- ghostty needs a
// WindowServer to open a window.

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
  const r = spawnSync('sh', ['-c', 'command -v "$0"', bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function sleep(ms) { spawnSync('sleep', [String(ms / 1000)]); }

// Normalize caller-supplied extra agent args to an array. An array is taken
// as-is (each element one argv token -- the safe form). A string is split on
// whitespace as a convenience (no quoting; use the array form for values with
// spaces).
function normalizeArgs(args) {
  if (!args) return [];
  if (Array.isArray(args)) return args.map(String);
  return String(args).trim() ? String(args).trim().split(/\s+/) : [];
}
// Quote one token for safe inclusion inside the `bash -c '...'` body we build.
// The body is double-quote-capable there, so wrap and escape shell-active chars.
function dq(s) { return '"' + String(s).replace(/(["\\$`])/g, '\\$1') + '"'; }

const ROOT = repoRoot();
const SENDKEYS = path.join(ROOT, 'sendkeys.js');
const GHOSTTY = path.join(ROOT, 'zig-out/Ghostty.app/Contents/MacOS/ghostty');
const SESSIONS_HOME = process.env.GHOSTTY_AGENT_HOME
  || path.join(os.homedir(), '.config', 'ghostty-agent', 'sessions');

// Pull an agent's LATEST reply out of its TUI. Replies are marked with `bullet`
// (claude "⏺", codex "•"); on a reused session scrollback holds older turns, so
// return only the LAST bullet block. A multi-line answer body is INDENTED under
// the bullet; anything flush-left (prompt, status line, next bullet) ends it.
// bullet=null (plain shell) -> just return the surface tail.
function makeExtractAnswer(bullet) {
  return function extractAnswer(surface) {
    const lines = (surface || '').split('\n').map((l) => l.replace(/\s+$/, ''));
    if (!bullet) return lines.filter((l) => l.trim()).slice(-5).join('\n').trim();
    let last = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith(bullet)) last = i;
    if (last === -1) return lines.filter((l) => l.trim()).slice(-3).join('\n').trim();
    const head = lines[last].trim();
    const out = [head.startsWith(bullet) ? head.slice(bullet.length).trim() : head];
    for (let i = last + 1; i < lines.length; i++) {
      if (!/^\s+\S/.test(lines[i])) break;   // continuation must be indented, non-empty
      out.push(lines[i].trim());
    }
    return out.join('\n').trim();
  };
}

// --- Agent descriptors: everything agent-specific lives here. ---------------
const AGENTS = {
  claude: {
    resolveBin: () => process.env.CLAUDE_BIN || whichSync('claude') || '/Users/muthuishere/.local/bin/claude',
    argv: '--dangerously-skip-permissions',
    readyMarker: 'bypass permissions',
    busyMarker: 'esc to interrupt',   // shown while generating; gone when idle
    bullet: '⏺',
    // Accept the folder-trust dialog, then wait for the "bypass permissions"
    // status line. Returns true when booted.
    boot(s) {
      const trust = s.sk(['waitfor', '--contains', 'trust', '--timeout-ms', '8000']);
      if (trust && trust.matched) s.sk(['send', 'KEY:enter']);
      for (let i = 0; i < 3; i++) {
        const b = s.sk(['waitfor', '--contains', 'bypass permissions', '--timeout-ms', '40000', '--settle-ms', '1500']);
        if (b && b.matched) return true;
      }
      return false;
    },
  },
  codex: {
    resolveBin: () => process.env.CODEX_BIN || whichSync('codex') || '/opt/homebrew/bin/codex',
    argv: '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
    readyMarker: 'OpenAI Codex',
    busyMarker: 'esc to interrupt',   // "Working (Ns • esc to interrupt)" while generating
    bullet: '•',
    // Codex opens with a variable sequence of selection gates (update nag,
    // directory-trust). Navigate each until the composer ("OpenAI Codex" and no
    // "Press enter" gate) is reached.
    boot(s) {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const surface = s.read(40);
        if (surface.includes('OpenAI Codex') && !surface.includes('Press enter')) return true;
        if (surface.includes('Update available!')) {
          // options: 1 Update now / 2 Skip / 3 Skip until next version -> pick 3
          s.sk(['send', 'KEY:down']); sleep(300);
          s.sk(['send', 'KEY:down']); sleep(300);
          s.sk(['send', 'KEY:enter']);
        } else if (surface.includes('Do you trust the contents')) {
          s.sk(['send', 'KEY:enter']);        // default "1. Yes, continue"
        } else if (surface.includes('Press enter')) {
          s.sk(['send', 'KEY:enter']);        // unknown gate: nudge forward
        }
        sleep(800);
      }
      return false;
    },
  },
  shell: {
    resolveBin: () => process.env.SHELL || '/bin/bash',
    argv: '',
    readyMarker: null,          // a shell has no boot banner
    bullet: null,               // answers are just terminal output
    boot() { sleep(600); return true; },
  },
};

class AgentSession {
  // opts: { name='default', agent='claude', cwd, bin, argv, enterDelayMs, reuse=true }
  constructor(opts = {}) {
    this.name = opts.name || 'default';
    this.agentType = opts.agent || 'claude';
    this.spec = AGENTS[this.agentType];
    if (!this.spec) throw new Error(`unknown agent: ${this.agentType} (have: ${Object.keys(AGENTS).join(', ')})`);
    this.dir = path.join(SESSIONS_HOME, this.name);
    this.spool = path.join(this.dir, 'spool');
    this.resp = path.join(this.dir, 'responses');
    this.log = path.join(this.dir, 'ghostty.log');
    this.pidfile = path.join(this.dir, 'ghostty.pid');
    this.metafile = path.join(this.dir, 'meta.json');
    this.cwd = opts.cwd || path.join(this.dir, 'cwd');
    this.reuse = opts.reuse !== false;
    this.enterDelayMs = opts.enterDelayMs;
    this.bin = opts.bin || this.spec.resolveBin();
    // argv = the agent's baseline/required flags (override with opts.argv);
    // args = EXTRA caller flags appended on top (e.g. --model, --profile, -c ...).
    this.argv = opts.argv != null ? opts.argv : this.spec.argv;
    this.args = normalizeArgs(opts.args);
    this.extractAnswer = makeExtractAnswer(this.spec.bullet);
    this.pid = 0;
  }

  sk(args, id) {
    const full = ['--dir', this.spool, '--resp-dir', this.resp];
    if (id) full.push('--id', id);
    const r = spawnSync('node', [SENDKEYS, ...full, ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    try { return JSON.parse((r.stdout || '').trim()); } catch (_) { return {}; }
  }

  read(lines = 40) { return (this.sk(['read', '--lines', String(lines)]).surface) || ''; }

  isLive() {
    const probe = this.sk(['read', '--lines', '1'], `__probe_${Date.now()}__`);
    return probe && probe.ok === true;
  }

  _mkdirs() { for (const d of [this.spool, this.resp, this.cwd]) fs.mkdirSync(d, { recursive: true }); }

  _launch() {
    const logfd = fs.openSync(this.log, 'a');
    const extra = this.args.map((a) => ' ' + dq(a)).join('');
    const agentCmd = `exec "${this.bin}"${this.argv ? ' ' + this.argv : ''}${extra}`;
    const command = `/bin/bash --noprofile --norc -c 'cd "${this.cwd}" && ${agentCmd}'`;
    const env = { ...process.env,
      GHOSTTY_SENDKEYS_DIR: this.spool,
      GHOSTTY_SENDKEYS_RESP_DIR: this.resp,
      GHOSTTY_LOG: 'info' };
    if (this.enterDelayMs != null) env.GHOSTTY_SENDKEYS_ENTER_DELAY_MS = String(this.enterDelayMs);
    const child = spawn(GHOSTTY, ['--window-save-state=never', `--command=${command}`],
      { env, stdio: ['ignore', logfd, logfd], detached: true });
    child.unref();
    this.pid = child.pid;
    fs.writeFileSync(this.pidfile, String(this.pid));
    fs.writeFileSync(this.metafile, JSON.stringify({ agent: this.agentType, cwd: this.cwd, bin: this.bin, args: this.args }));
  }

  _ready() { return !this.spec.readyMarker || this.read(40).includes(this.spec.readyMarker); }

  // Start if not running, else reuse. Returns { reused }. Throws on failure.
  open() {
    this._mkdirs();
    if (this.reuse && this.isLive()) {
      if (this._ready()) return { reused: true };
      if (!this.spec.boot(this)) throw new Error(`reused '${this.name}' never reached a ready ${this.agentType}`);
      return { reused: true };
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      this._launch();
      if (this.isLive()) {
        if (!this.spec.boot(this)) throw new Error(`${this.agentType} never booted after launch`);
        return { reused: false };
      }
      this.close();
      sleep(2000);
    }
    const mgr = (spawnSync('launchctl', ['managername'], { encoding: 'utf8' }).stdout || '').trim();
    throw new Error(
      'ghostty never created a WATCHED surface -- almost always NO GUI/WindowServer '
      + `(Aqua) session. launchctl managername=${mgr} TMUX=${process.env.TMUX || '<none>'}. `
      + 'Run from a real GUI terminal, not a detached tmux/ssh/background context.');
  }
  ensure() { return this.open(); }   // alias

  // Wait until the agent is idle after a prompt, then return the settled surface.
  // These TUIs STREAM the reply and show a busy marker ("esc to interrupt") while
  // generating, so the reliable "done" signal is: the busy marker appeared and
  // then stayed gone for settleMs. (A plain substring waitfor is unreliable here
  // -- it fires mid-stream, and on a reused session it can match an OLD answer
  // still in scrollback.) Agents with no busy marker (shell) settle on change.
  _waitIdle(timeoutMs, settleMs, before) {
    const busy = this.spec.busyMarker;
    const start = Date.now();
    if (busy) {
      // Give the agent up to ~5s to pick up the prompt and show "busy". If it
      // never does (a very fast/trivial reply), fall through to the clear-check.
      for (; Date.now() - start < Math.min(5000, timeoutMs);) {
        if (this.read(60).includes(busy)) break;
        sleep(200);
      }
      let lastBusy = Date.now();
      while (Date.now() - start < timeoutMs) {
        const s = this.read(200);
        if (s.includes(busy)) lastBusy = Date.now();
        else if (Date.now() - lastBusy >= settleMs) return s;
        sleep(200);
      }
      return this.read(200);
    }
    let last = before, lastChange = Date.now(), changed = false;
    while (Date.now() - start < timeoutMs) {
      const cur = this.read(200);
      if (cur !== last) { last = cur; lastChange = Date.now(); if (cur !== before) changed = true; }
      else if (changed && Date.now() - lastChange >= settleMs) break;
      sleep(250);
    }
    return last;
  }

  // Ask a prompt; return { answer, surface, matched }. `answer` is the agent's
  // latest reply. `opts.expect`, when given, is asserted against that EXTRACTED
  // answer (not raw scrollback), so `matched` means "the new answer contains it".
  ask(prompt, opts = {}) {
    const timeoutMs = opts.timeoutMs || 90000;
    const settleMs = opts.settleMs || (this.spec.busyMarker ? 900 : 1500);
    const before = this.read(200);
    this.sk(['prompt', prompt]);
    const surface = this._waitIdle(timeoutMs, settleMs, before);
    const answer = this.extractAnswer(surface);
    const matched = opts.expect ? answer.includes(opts.expect) : answer.length > 0;
    return { answer, surface, matched };
  }

  close() {
    let pid = this.pid;
    if (!pid) { try { pid = parseInt(fs.readFileSync(this.pidfile, 'utf8'), 10); } catch (_) {} }
    if (pid) { try { process.kill(pid); } catch (_) {} }
    this.pid = 0;
    try { fs.unlinkSync(this.pidfile); } catch (_) {}
  }
  kill() { return this.close(); }   // alias
}

// --- Browser-like manager over many named sessions. ------------------------
class SessionManager {
  // A session remembers its agent type in meta.json, so `ask <name>` doesn't
  // need --agent repeated (and can't mismatch: asking a codex tab as claude).
  // Explicit opts.agent wins; else the persisted type; else 'claude' for a new one.
  _resolveAgent(name, explicit) {
    if (explicit) return explicit;
    try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_HOME, name, 'meta.json'), 'utf8')).agent || 'claude'; }
    catch (_) { return 'claude'; }
  }
  open(name, opts = {}) {
    const s = new AgentSession({ ...opts, name, agent: this._resolveAgent(name, opts.agent) });
    const { reused } = s.open();
    s._reused = reused;
    return s;
  }
  session(name, opts = {}) { return new AgentSession({ ...opts, name, agent: this._resolveAgent(name, opts.agent) }); }
  ask(name, prompt, opts = {}) {
    const s = this.open(name, opts);
    return { ...s.ask(prompt, opts), reused: s._reused };
  }
  close(name) { new AgentSession({ name, reuse: true }).close(); }

  // Every session dir that has a meta.json, with live/pid status.
  list() {
    let names = [];
    try { names = fs.readdirSync(SESSIONS_HOME); } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      const metafile = path.join(SESSIONS_HOME, name, 'meta.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metafile, 'utf8')); } catch (_) { continue; }
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(path.join(SESSIONS_HOME, name, 'ghostty.pid'), 'utf8'), 10); } catch (_) {}
      const s = new AgentSession({ name, agent: meta.agent });
      out.push({ name, agent: meta.agent, live: s.isLive(), pid: pid || null });
    }
    return out;
  }
  closeAll() { for (const s of this.list()) this.close(s.name); }
}

// One-shot convenience across any agent.
function driveAgent(opts = {}) {
  const s = new AgentSession(opts);
  const { reused } = s.open();
  const r = s.ask(opts.prompt, opts);
  if (opts.close) s.close();
  return { ...r, reused, session: s };
}

module.exports = {
  AgentSession, SessionManager, AGENTS, driveAgent, makeExtractAnswer,
  SESSIONS_HOME,
};
