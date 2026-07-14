#!/usr/bin/env node
'use strict';

// Companion CLI for Ghostty's GHOSTTY_SENDKEYS_DIR spike watcher
// (see sendkeysWatcherStart in src/Surface.zig). Ghostty polls a spool
// directory for files and injects their newline-delimited TEXT:/KEY:
// lines as synthetic key events, deleting each file once processed.
//
// v1 (one-way): `add` stages lines, `push` atomically publishes them as
// one spool file (write-as-dotfile, then rename into place).
//
//   sendkeys.js --dir /path/to/spool type "echo hi"
//   sendkeys.js --dir /path/to/spool key enter
//   sendkeys.js --dir /path/to/spool push
//
// v2 (two-way): the watcher writes an <id>.response.json into a responses
// directory (default <dir>/responses, override --resp-dir /
// $GHOSTTY_SENDKEYS_RESP_DIR) for any line carrying an "@<id> " prefix.
// These subcommands generate an id, push one line, then poll for and
// print the response:
//
//   sendkeys.js --dir /spool read [--lines N]
//   sendkeys.js --dir /spool waitfor --contains READY [--timeout-ms N] [--settle-ms N]
//   sendkeys.js --dir /spool prompt "echo hi"        (type + Enter atomically)
//   sendkeys.js --dir /spool type "echo hi" --wait   (v1 verb + delivery ack)
//
// See SENDKEYS_SPEC.md "Two-way protocol (v2)".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STAGING_NAME = '.ghostty-sendkeys-staging';

function usage() {
  console.log(`ghostty sendkeys CLI

Stages synthetic key/text events for Ghostty's GHOSTTY_SENDKEYS_DIR
watcher, then atomically publishes them for Ghostty to pick up.

One-way (v1):
  sendkeys.js add  <TEXT:...|KEY:...|literal text>   stage a line
  sendkeys.js type <text>                            stage a TEXT: line
  sendkeys.js key  <combo>                           stage a KEY: line (e.g. ctrl+c)
  sendkeys.js send <TEXT:...|KEY:...|literal text>   stage + push in one call
  sendkeys.js push                                   publish staged lines atomically

Two-way (v2, request -> response):
  sendkeys.js prompt  <text>                         type text + Enter, return ack
  sendkeys.js read    [--lines N | --all]            snapshot the surface (visible/full)
  sendkeys.js gettext --all                          alias for read --all (full scrollback)
  sendkeys.js waitfor --contains <text>              block until surface contains text
                      [--timeout-ms N] [--settle-ms N]
  sendkeys.js type|key|send <...> --wait             v1 verb + delivery ack

Local (no watcher; producer-side capture):
  sendkeys.js screenshot <path> [--pid <ghostty pid>]  PNG of the ghostty window (macOS)

Options:
  --dir <path>        spool directory (default: $GHOSTTY_SENDKEYS_DIR)
  --resp-dir <path>   responses directory (default: <dir>/responses,
                      or $GHOSTTY_SENDKEYS_RESP_DIR)
  --id <id>           explicit request id (default: auto-generated)
  --wait              opt a v1 verb into a delivery-ack response
  --all               read the full scrollback, not just the visible viewport
  --lines <N>         read only the last N lines
  --pid <N>           ghostty process id (for screenshot window resolution)
`);
}

function stagingPath(dir) {
  return path.join(dir, STAGING_NAME);
}

// A bare line with no KEY:/TEXT:/PROMPT: prefix defaults to TEXT, mirroring
// the Zig-side sendkeysProcessLine behavior.
function normalizeLine(raw) {
  const m = /^(key|text|prompt):/i.exec(raw);
  if (m) return m[1].toUpperCase() + ':' + raw.slice(m[0].length);
  return 'TEXT:' + raw;
}

// Generate a request id in the watcher's [A-Za-z0-9._-] charset.
function genId() {
  return `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Build a request line, optionally with the "@<id> " two-way prefix.
function buildLine(payload, id) {
  return id ? `@${id} ${payload}` : payload;
}

// Encode a waitfor payload: WAITFOR:<timeout_ms>|<settle_ms>|<needle>.
function buildWaitforPayload(needle, timeoutMs, settleMs) {
  return `WAITFOR:${timeoutMs}|${settleMs}|${needle}`;
}

function respDirFor(dir, respDir) {
  return respDir || process.env.GHOSTTY_SENDKEYS_RESP_DIR || path.join(dir, 'responses');
}

// Atomically publish `lines` (array or string) as one spool file.
function pushLines(dir, lines) {
  const body = (Array.isArray(lines) ? lines.join('\n') : lines).replace(/\n?$/, '\n');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.push-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, body);
  const name = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.txt`;
  const dest = path.join(dir, name);
  fs.renameSync(tmp, dest);
  return dest;
}

// Poll the responses dir for <id>.response.json until it appears or the
// deadline passes. On success, read + delete it and return the parsed JSON.
// Returns null on timeout. Synchronous (busy-waits with tiny sleeps) so the
// CLI stays a simple sequential tool.
function pollResponse(respDir, id, deadlineMs) {
  const file = path.join(respDir, `${id}.response.json`);
  const start = Date.now();
  for (;;) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      try {
        fs.unlinkSync(file);
      } catch (_) {}
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (Date.now() - start >= deadlineMs) return null;
    sleepMs(25);
  }
}

// Blocking sleep without extra deps (Atomics.wait on a throwaway buffer).
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cmdAdd(dir, args) {
  const text = args.join(' ');
  if (!text) {
    console.error('usage: sendkeys.js add <TEXT:...|KEY:...|literal text>');
    process.exit(1);
  }
  const line = normalizeLine(text);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(stagingPath(dir), line + '\n');
  console.log('staged: ' + line);
}

function cmdPush(dir) {
  const staging = stagingPath(dir);
  if (!fs.existsSync(staging)) {
    console.error('nothing staged (run "add"/"type"/"key" first)');
    process.exit(1);
  }
  const name = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.txt`;
  const dest = path.join(dir, name);
  fs.renameSync(staging, dest);
  console.log('pushed: ' + dest);
}

// Push one request line and (if it carries an id) wait for + print its
// response. Returns the parsed response object, or null.
function sendAndMaybeWait(dir, opts, payload, deadlineMs) {
  const id = opts.id;
  const line = buildLine(payload, id);
  pushLines(dir, [line]);
  if (!id) {
    console.log('pushed: ' + line);
    return null;
  }
  const resp = pollResponse(respDirFor(dir, opts.respDir), id, deadlineMs);
  if (resp === null) {
    console.error(`timed out waiting for response id=${id}`);
    process.exit(2);
  }
  console.log(JSON.stringify(resp, null, 2));
  return resp;
}

// Resolve the CGWindowID of the largest on-screen window owned by `pid`
// (macOS), via a JXA/ObjC-bridge query -- deterministic by owner PID, unlike
// the flaky "System Events window of process by pid" path. Returns null if
// unresolved. Requires no Screen Recording permission for the *lookup*.
function resolveWindowId(pid) {
  const jxa = `
function run(argv) {
  ObjC.import('CoreGraphics');
  const pid = parseInt(argv[0], 10);
  const opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const info = $.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID);
  // Iterate the CFArray by index (deepUnwrap can yield a non-iterable value).
  const n = info.count;
  let best = null;
  for (let i = 0; i < n; i++) {
    const w = ObjC.deepUnwrap(info.objectAtIndex(i)) || {};
    if (w.kCGWindowOwnerPID !== pid) continue;
    const b = w.kCGWindowBounds || {};
    const area = (b.Width || 0) * (b.Height || 0);
    if (!best || area > best.area) best = { id: w.kCGWindowNumber, area };
  }
  return best ? String(best.id) : '';
}`;
  const tmp = path.join(os.tmpdir(), `sk-winid-${process.pid}.js`);
  fs.writeFileSync(tmp, jxa);
  try {
    const out = execFileSync('osascript', ['-l', 'JavaScript', tmp, String(pid)], {
      encoding: 'utf8',
    }).trim();
    return out || null;
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Capture a PNG of the ghostty window to `dest`. Prefers a window-scoped
// capture resolved by `pid` (macOS `screencapture -l<id>`); falls back to a
// full-screen grab if the window can't be resolved. NOTE: a window/screen
// capture needs Screen Recording permission for the invoking terminal, else
// the PNG may be blank -- documented in the spec.
function cmdScreenshot(dest, pid) {
  if (!dest) {
    console.error('usage: sendkeys.js screenshot <path> [--pid <ghostty pid>]');
    process.exit(1);
  }
  if (process.platform !== 'darwin') {
    console.error('screenshot is macOS-only in this spike');
    process.exit(1);
  }
  let winId = null;
  if (pid) winId = resolveWindowId(pid);
  try {
    if (winId) {
      execFileSync('screencapture', ['-x', '-o', `-l${winId}`, dest]);
      console.log(`screenshot: window ${winId} (pid ${pid}) -> ${dest}`);
    } else {
      execFileSync('screencapture', ['-x', dest]);
      console.log(`screenshot: full screen (window unresolved) -> ${dest}`);
    }
  } catch (err) {
    console.error('screencapture failed: ' + err.message);
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);

  let dir = process.env.GHOSTTY_SENDKEYS_DIR || null;
  const opts = { id: null, respDir: null, wait: false, lines: null, all: false, contains: null, timeoutMs: 30000, settleMs: 0, pid: null };
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') dir = argv[++i];
    else if (a === '--resp-dir') opts.respDir = argv[++i];
    else if (a === '--id') opts.id = argv[++i];
    else if (a === '--wait') opts.wait = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--lines') opts.lines = parseInt(argv[++i], 10);
    else if (a === '--contains') opts.contains = argv[++i];
    else if (a === '--timeout-ms') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--settle-ms') opts.settleMs = parseInt(argv[++i], 10);
    else if (a === '--pid') opts.pid = parseInt(argv[++i], 10);
    else args.push(a);
  }

  // screenshot is a local capture -- no spool dir needed.
  if (argv[0] === 'screenshot' || args[0] === 'screenshot') {
    const rest = args.filter((x) => x !== 'screenshot');
    return cmdScreenshot(rest[0], opts.pid);
  }

  const cmd = args.shift();
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (!dir) {
    console.error('error: no spool directory set. Pass --dir <path> or set GHOSTTY_SENDKEYS_DIR.');
    process.exit(1);
  }

  // v1 verbs opt into a two-way ack when --wait (or --id) is given.
  const wantAck = opts.wait || !!opts.id;
  if (wantAck && !opts.id) opts.id = genId();

  switch (cmd) {
    case 'add':
      return cmdAdd(dir, args);
    case 'type':
      if (wantAck) return void sendAndMaybeWait(dir, opts, 'TEXT:' + args.join(' '), 10000);
      return cmdAdd(dir, ['TEXT:' + args.join(' ')]);
    case 'key':
      if (wantAck) return void sendAndMaybeWait(dir, opts, 'KEY:' + args.join(' '), 10000);
      return cmdAdd(dir, ['KEY:' + args.join(' ')]);
    case 'send':
      if (wantAck) return void sendAndMaybeWait(dir, opts, normalizeLine(args.join(' ')), 10000);
      cmdAdd(dir, args);
      return cmdPush(dir);
    case 'push':
      return cmdPush(dir);
    case 'prompt': {
      if (!opts.id) opts.id = genId();
      return void sendAndMaybeWait(dir, opts, 'PROMPT:' + args.join(' '), 10000);
    }
    case 'read':
    case 'gettext': {
      if (!opts.id) opts.id = genId();
      let payload = 'READ';
      if (opts.all) payload = 'READ:all';
      else if (Number.isInteger(opts.lines)) payload = `READ:${opts.lines}`;
      return void sendAndMaybeWait(dir, opts, payload, 10000);
    }
    case 'waitfor': {
      if (opts.contains == null) {
        console.error('usage: sendkeys.js waitfor --contains <text> [--timeout-ms N] [--settle-ms N]');
        process.exit(1);
      }
      if (!opts.id) opts.id = genId();
      const payload = buildWaitforPayload(opts.contains, opts.timeoutMs, opts.settleMs);
      // Client must outlast the server-side timeout.
      return void sendAndMaybeWait(dir, opts, payload, opts.timeoutMs + 15000);
    }
    default:
      console.error('unknown command: ' + cmd);
      usage();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeLine,
  genId,
  buildLine,
  buildWaitforPayload,
  respDirFor,
  pollResponse,
  pushLines,
};
