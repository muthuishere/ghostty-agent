'use strict';
// Tests for the agent-session engine (claude + codex + shell) and the manager.
//   node --test .claude/skills/ghostty-sendkeys/scripts/agent-session.test.js
//
// Answer-extraction tests are pure and always run. The live drives (real
// ghostty + agent) are gated behind DRIVE_CLAUDE_E2E=1 / DRIVE_CODEX_E2E=1 so a
// plain `node --test` stays headless-safe (they need a GUI/Aqua session, the
// built fork, and the respective CLI installed):
//   DRIVE_CLAUDE_E2E=1 DRIVE_CODEX_E2E=1 node --test .../agent-session.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { makeExtractAnswer, driveAgent } = require('./agent-session.js');

const extractClaude = makeExtractAnswer('⏺');
const extractCodex = makeExtractAnswer('•');
const extractShell = makeExtractAnswer(null);

test('claude: single bullet answer', () => {
  assert.strictEqual(extractClaude(['❯ q', '⏺ 42', '✻ Brewed', '❯ '].join('\n')), '42');
});

test('claude: only the LATEST bullet on a reused session', () => {
  assert.strictEqual(extractClaude(['⏺ 42', '❯ q2', '⏺ 100', '❯ '].join('\n')), '100');
});

test('claude: multi-line body kept, stops at prompt/status', () => {
  assert.strictEqual(extractClaude(['⏺ line one', '  line two', '', '❯ '].join('\n')), 'line one\nline two');
});

test('codex: single bullet answer', () => {
  assert.strictEqual(extractCodex(['› q', '• 42', '', '› placeholder'].join('\n')), '42');
});

test('codex: latest bullet, ignoring an earlier notice bullet', () => {
  const surface = ['• You have 4 usage limit resets available.', '› q', '• 42', '› placeholder'].join('\n');
  assert.strictEqual(extractCodex(surface), '42');
});

test('shell: no bullet -> surface tail', () => {
  assert.strictEqual(extractShell(['$ echo hi', 'hi', '$ '].join('\n')), '$ echo hi\nhi\n$');
});

test('extractAnswer falls back to tail when no bullet present', () => {
  assert.strictEqual(extractClaude(['booting...', '', 'ready'].join('\n')), 'booting...\nready');
});

test('claude e2e: drive a real session to answer 42', { skip: process.env.DRIVE_CLAUDE_E2E !== '1' }, () => {
  const { answer, matched } = driveAgent({
    name: 'e2e-claude', agent: 'claude', expect: '42', close: true,
    prompt: 'What is 21 plus 21? Reply with only the number and nothing else.',
  });
  assert.ok(matched);
  assert.match(answer, /42/, `got: ${answer}`);
});

test('codex e2e: drive a real session to answer 42', { skip: process.env.DRIVE_CODEX_E2E !== '1' }, () => {
  const { answer, matched } = driveAgent({
    name: 'e2e-codex', agent: 'codex', expect: '42', close: true,
    prompt: 'What is 21 plus 21? Reply with only the number and nothing else.',
  });
  assert.ok(matched);
  assert.match(answer, /42/, `got: ${answer}`);
});
