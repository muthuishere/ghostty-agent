'use strict';

// Headless tests for the sendkeys producer CLI's pure request/response
// logic -- no running Ghostty required. Run with: node --test sendkeys.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sk = require('./sendkeys.js');

test('normalizeLine keeps known prefixes, defaults bare -> TEXT', () => {
  assert.equal(sk.normalizeLine('KEY:enter'), 'KEY:enter');
  assert.equal(sk.normalizeLine('text:hi'), 'TEXT:hi');
  assert.equal(sk.normalizeLine('prompt:go'), 'PROMPT:go');
  assert.equal(sk.normalizeLine('echo hi'), 'TEXT:echo hi');
});

test('genId is within the watcher [A-Za-z0-9._-] charset', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(sk.genId(), /^[A-Za-z0-9._-]+$/);
  }
});

test('buildLine prepends @<id> only when an id is given', () => {
  assert.equal(sk.buildLine('READ', 'abc'), '@abc READ');
  assert.equal(sk.buildLine('KEY:enter', null), 'KEY:enter');
});

test('buildWaitforPayload encodes timeout|settle|needle, needle may contain |', () => {
  assert.equal(sk.buildWaitforPayload('READY', 60000, 0), 'WAITFOR:60000|0|READY');
  assert.equal(sk.buildWaitforPayload('a|b|c', 500, 300), 'WAITFOR:500|300|a|b|c');
});

test('respDirFor defaults to <dir>/responses, honors override', () => {
  const prev = process.env.GHOSTTY_SENDKEYS_RESP_DIR;
  delete process.env.GHOSTTY_SENDKEYS_RESP_DIR;
  assert.equal(sk.respDirFor('/spool', null), path.join('/spool', 'responses'));
  assert.equal(sk.respDirFor('/spool', '/custom'), '/custom');
  process.env.GHOSTTY_SENDKEYS_RESP_DIR = '/env';
  assert.equal(sk.respDirFor('/spool', null), '/env');
  if (prev === undefined) delete process.env.GHOSTTY_SENDKEYS_RESP_DIR;
  else process.env.GHOSTTY_SENDKEYS_RESP_DIR = prev;
});

test('pushLines writes an atomic .txt spool file (no dotfile left behind)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-'));
  const dest = sk.pushLines(dir, ['@id1 READ', 'TEXT:hi']);
  assert.ok(dest.endsWith('.txt'));
  assert.equal(fs.readFileSync(dest, 'utf8'), '@id1 READ\nTEXT:hi\n');
  const leftovers = fs.readdirSync(dir).filter((n) => n.startsWith('.push-'));
  assert.equal(leftovers.length, 0);
});

test('pollResponse reads + deletes an existing response, returns parsed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-resp-'));
  const body = { id: 'w1', ok: true, verb: 'read', surface: 'READY' };
  fs.writeFileSync(path.join(dir, 'w1.response.json'), JSON.stringify(body));
  const got = sk.pollResponse(dir, 'w1', 1000);
  assert.deepEqual(got, body);
  assert.equal(fs.existsSync(path.join(dir, 'w1.response.json')), false);
});

test('pollResponse returns null after the deadline when no file appears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-to-'));
  const start = Date.now();
  const got = sk.pollResponse(dir, 'missing', 150);
  const elapsed = Date.now() - start;
  assert.equal(got, null);
  assert.ok(elapsed >= 140, `expected to wait ~150ms, waited ${elapsed}ms`);
});
