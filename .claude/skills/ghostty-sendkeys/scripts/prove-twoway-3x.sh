#!/usr/bin/env bash
#
# prove-twoway-3x.sh -- the CEO acceptance bar (CEO-VERIFY-FAIL-1): one COLD
# `zig build`, then prove-twoway.sh must pass 3 times CONSECUTIVELY, each run
# driving a real claude session to answer "42". Records every run.
#
# Usage: .claude/skills/ghostty-sendkeys/scripts/prove-twoway-3x.sh
# Exit:  0 iff all 3 runs are green.

set -uo pipefail
# Repo root: this script lives inside the skill; resolve the real top-level.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE" && git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(cd "$HERE/../../../.." && pwd)"
ZIG="${ZIG:-/opt/homebrew/opt/zig@0.15/bin/zig}"
command -v "$ZIG" >/dev/null 2>&1 || ZIG="zig"

echo "############ COLD BUILD ($ZIG build) ############"
rm -rf "$ROOT/zig-out/Ghostty.app"          # force a fresh app bundle relink
if ! ( cd "$ROOT" && "$ZIG" build ); then
  echo "ACCEPTANCE: FAILED (cold build failed)"; exit 1
fi
BIN="$ROOT/zig-out/Ghostty.app/Contents/MacOS/ghostty"
echo "built: $BIN"
ls -la "$BIN"

pass=0
for run in 1 2 3; do
  echo; echo "############ RUN $run/3 ############"
  # SKIP_BUILD=1: use the exact cold-built binary for all three runs.
  if SKIP_BUILD=1 bash "$HERE/prove-twoway.sh"; then
    echo ">>> RUN $run: GREEN"; pass=$((pass + 1))
  else
    echo ">>> RUN $run: RED (stopping)"; break
  fi
done

echo; echo "############ RESULT: $pass/3 green ############"
if [ "$pass" -eq 3 ]; then
  echo "ACCEPTANCE: 3/3 GREEN"
  exit 0
else
  echo "ACCEPTANCE: FAILED ($pass/3)"
  exit 1
fi
