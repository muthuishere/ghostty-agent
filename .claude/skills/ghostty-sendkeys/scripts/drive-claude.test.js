'use strict';
// Tests for the drive-claude capability.
//   node --test .claude/skills/ghostty-sendkeys/scripts/drive-claude.test.js
//
// The extractAnswer tests are pure and always run. The end-to-end test actually
// spawns ghostty+claude and is gated behind DRIVE_CLAUDE_E2E=1 (needs a real GUI
// / Aqua session and the fork built) so a plain `node --test` stays headless-safe:
//   DRIVE_CLAUDE_E2E=1 node --test .../drive-claude.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { extractAnswer, driveClaude } = require('./drive-claude.js');

test('extractAnswer returns the single bullet answer', () => {
  const surface = ['❯ What is 21 plus 21?', '⏺ 42', '✻ Brewed for 1s', '❯ '].join('\n');
  assert.strictEqual(extractAnswer(surface), '42');
});

test('extractAnswer returns only the LATEST bullet on a reused session', () => {
  // scrollback holds an earlier turn (42) plus the new one (100)
  const surface = ['⏺ 42', '❯ What is 50 plus 50?', '⏺ 100', '✻ Worked', '❯ '].join('\n');
  assert.strictEqual(extractAnswer(surface), '100');
});

test('extractAnswer keeps a multi-line answer body but stops at the prompt', () => {
  const surface = ['⏺ line one', '  line two', '', '❯ '].join('\n');
  assert.strictEqual(extractAnswer(surface), 'line one\nline two');
});

test('extractAnswer falls back to the surface tail when no bullet is present', () => {
  const surface = ['booting...', '', 'ready'].join('\n');
  assert.strictEqual(extractAnswer(surface), 'booting...\nready');
});

test('end-to-end: drive a real claude session to answer 42', { skip: process.env.DRIVE_CLAUDE_E2E !== '1' }, () => {
  const { answer, matched, reused } = driveClaude({
    name: 'e2e-test',
    expect: '42',
    close: true,
    prompt: 'What is 21 plus 21? Reply with only the number and nothing else.',
  });
  assert.ok(matched, 'model answer was not observed');
  assert.match(answer, /42/, `expected 42 in answer, got: ${answer}`);
  assert.strictEqual(typeof reused, 'boolean');
});
