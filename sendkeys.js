#!/usr/bin/env node
'use strict';

// Small companion CLI for Ghostty's GHOSTTY_SENDKEYS_DIR spike watcher
// (see sendkeysWatcherStart in src/Surface.zig). Ghostty polls a spool
// directory for files and injects their newline-delimited TEXT:/KEY:
// lines as synthetic key events, deleting each file once processed.
//
// This CLI is the producer side: `add` stages lines into a local
// buffer, `push` atomically publishes that buffer as one spool file
// (write-as-dotfile, then rename into place, per Ghostty's atomic
// publish requirement so it never sees a half-written file).
//
//   sendkeys.js --dir /path/to/spool type "echo hi"
//   sendkeys.js --dir /path/to/spool key enter
//   sendkeys.js --dir /path/to/spool push
//
// Or stage multiple lines before publishing them together:
//
//   sendkeys.js --dir /path/to/spool add "TEXT:echo hi"
//   sendkeys.js --dir /path/to/spool add "KEY:enter"
//   sendkeys.js --dir /path/to/spool push

const fs = require('fs');
const path = require('path');

const STAGING_NAME = '.ghostty-sendkeys-staging';

function usage() {
  console.log(`ghostty sendkeys CLI

Stages synthetic key/text events for Ghostty's GHOSTTY_SENDKEYS_DIR
watcher, then atomically publishes them for Ghostty to pick up.

Usage:
  sendkeys.js add  <TEXT:...|KEY:...|literal text>   stage a line
  sendkeys.js type <text>                            stage a TEXT: line
  sendkeys.js key  <combo>                           stage a KEY: line (e.g. ctrl+c)
  sendkeys.js send <TEXT:...|KEY:...|literal text>   stage + push in one call
  sendkeys.js push                                   publish staged lines atomically

Options:
  --dir <path>   spool directory (default: $GHOSTTY_SENDKEYS_DIR)

Examples:
  sendkeys.js --dir /tmp/spool type "echo hi"
  sendkeys.js --dir /tmp/spool key enter
  sendkeys.js --dir /tmp/spool push
`);
}

function stagingPath(dir) {
  return path.join(dir, STAGING_NAME);
}

// A bare line with no KEY:/TEXT: prefix defaults to TEXT, mirroring the
// Zig-side sendkeysProcessLine behavior.
function normalizeLine(raw) {
  const m = /^(key|text):/i.exec(raw);
  if (m) return m[1].toUpperCase() + ':' + raw.slice(m[0].length);
  return 'TEXT:' + raw;
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

  // Sortable-ish unique name: Ghostty processes files in filename
  // order, so a timestamp prefix keeps pushes roughly ordered even
  // with multiple concurrent producers.
  const name = `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.txt`;
  const dest = path.join(dir, name);

  // rename(2) is atomic on the same filesystem, which is guaranteed
  // here since both paths are inside `dir`. Ghostty's watcher ignores
  // dotfiles, so it never observes the staging file mid-write.
  fs.renameSync(staging, dest);
  console.log('pushed: ' + dest);
}

function main() {
  const argv = process.argv.slice(2);

  let dir = process.env.GHOSTTY_SENDKEYS_DIR || null;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      dir = argv[++i];
    } else {
      args.push(argv[i]);
    }
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

  switch (cmd) {
    case 'add':
      return cmdAdd(dir, args);
    case 'type':
      return cmdAdd(dir, ['TEXT:' + args.join(' ')]);
    case 'key':
      return cmdAdd(dir, ['KEY:' + args.join(' ')]);
    case 'send':
      cmdAdd(dir, args);
      return cmdPush(dir);
    case 'push':
      return cmdPush(dir);
    default:
      console.error('unknown command: ' + cmd);
      usage();
      process.exit(1);
  }
}

main();
