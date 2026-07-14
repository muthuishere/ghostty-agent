#!/usr/bin/env node
//
// prove-twoway-3x.js -- the acceptance bar (CEO-VERIFY-FAIL-1): one COLD
// `zig build`, then prove-twoway.js must pass 3 times CONSECUTIVELY, each run
// driving a real claude session to answer "42". Pure Node -- no shell wrapper.
//
// Usage: node .claude/skills/ghostty-sendkeys/scripts/prove-twoway-3x.js
// Exit:  0 iff all 3 runs are green.

'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HERE = __dirname;
let ROOT;
try {
  ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'],
    { cwd: HERE, encoding: 'utf8' }).trim();
} catch (_) {
  ROOT = path.resolve(HERE, '../../../..');
}
let ZIG = process.env.ZIG || '/opt/homebrew/opt/zig@0.15/bin/zig';
if (!fs.existsSync(ZIG)) ZIG = 'zig';

console.log(`############ COLD BUILD (${ZIG} build) ############`);
fs.rmSync(path.join(ROOT, 'zig-out/Ghostty.app'), { recursive: true, force: true }); // force a fresh relink
if (spawnSync(ZIG, ['build'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
  console.log('ACCEPTANCE: FAILED (cold build failed)');
  process.exit(1);
}
const BIN = path.join(ROOT, 'zig-out/Ghostty.app/Contents/MacOS/ghostty');
console.log(`built: ${BIN}`);
console.log(spawnSync('ls', ['-la', BIN], { encoding: 'utf8' }).stdout.trim());

let pass = 0;
for (let run = 1; run <= 3; run++) {
  console.log(`\n############ RUN ${run}/3 ############`);
  // SKIP_BUILD=1: reuse the exact cold-built binary for all three runs.
  const r = spawnSync('node', [path.join(HERE, 'prove-twoway.js')], {
    stdio: 'inherit',
    env: { ...process.env, SKIP_BUILD: '1' },
  });
  if (r.status === 0) { console.log(`>>> RUN ${run}: GREEN`); pass++; }
  else { console.log(`>>> RUN ${run}: RED (stopping)`); break; }
}

console.log(`\n############ RESULT: ${pass}/3 green ############`);
if (pass === 3) { console.log('ACCEPTANCE: 3/3 GREEN'); process.exit(0); }
console.log(`ACCEPTANCE: FAILED (${pass}/3)`);
process.exit(1);
