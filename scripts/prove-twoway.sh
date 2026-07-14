#!/usr/bin/env bash
#
# prove-twoway.sh -- end-to-end proof that the two-way (v2) sendkeys protocol
# reliably DRIVES a real interactive `claude` session from an external process:
# type, wait on observed surface state, and confirm the model actually answered.
# This is the reliable visible-spawn primitive the fleet needs to replace blind
# `tmux send-keys` for CEO wakes.
#
# TWO root-cause fixes make this reliable (see SENDKEYS_SPEC.md "The Enter bug"):
#   1. text->Enter separation: a TUI (Claude Code/Ink) treats a fast text burst
#      + trailing CR as a paste, swallowing the CR as a literal newline instead
#      of submitting. PROMPT injects the text, waits (GHOSTTY_SENDKEYS_ENTER_
#      DELAY_MS, default 250ms), THEN injects Enter as a distinct keypress.
#   2. clean environment: the operator's login shell auto-attaches tmux (+direnv),
#      producing a ghostty->zsh->tmux->claude stack that misroutes injected input
#      to the shell and flaps the active screen. We launch claude DIRECTLY as
#      ghostty's PTY process via `--command`, bypassing the login shell entirely.
#
# Acceptance (owner): PROMPT "What is 21 plus 21? ..." then WAITFOR "42" must
# match -- "42" is NOT in the prompt, so a match can only be the model's output,
# proving Enter submitted in the TUI.
#
# Usage: scripts/prove-twoway.sh          (builds first, then one run)
#        SKIP_BUILD=1 scripts/prove-twoway.sh   (skip the build; used by the 3x
#                                                 wrapper after one cold build)
# Exit:  0 = PASS, non-zero = FAIL.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SK="$ROOT/sendkeys.js"
CLAUDE="${CLAUDE_BIN:-$(command -v claude || echo /Users/muthuishere/.local/bin/claude)}"

# --- Build first, then run THAT EXACT binary (CEO-VERIFY-FAIL-1: never test a
#     stale install -- a binary without the two-way Zig code silently TYPES a
#     WAITFOR: line as text, so no response is ever written). ------------------
ZIG="${ZIG:-/opt/homebrew/opt/zig@0.15/bin/zig}"
command -v "$ZIG" >/dev/null 2>&1 || ZIG="zig"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "--- building the fork ($ZIG build) ---"
  if ! ( cd "$ROOT" && "$ZIG" build ); then
    echo "PROVE-TWOWAY: FAIL  (zig build failed)"; exit 1
  fi
fi
GH="$ROOT/zig-out/Ghostty.app/Contents/MacOS/ghostty"
if [ ! -x "$GH" ]; then
  echo "PROVE-TWOWAY: FAIL  (no binary at $GH -- run zig build)"; exit 1
fi
# Fail loudly if the binary predates the two-way source (stale build).
if [ "$ROOT/src/Surface.zig" -nt "$GH" ]; then
  echo "PROVE-TWOWAY: FAIL  (binary is OLDER than src/Surface.zig -- stale build)"; exit 1
fi

WORK="$(mktemp -d /tmp/prove-twoway.XXXXXX)"
SPOOL="$WORK/spool"
RESP="$WORK/responses"
LOG="$WORK/ghostty.log"
# Run claude in a CLEAN, empty working dir: no repo CLAUDE.md to load, so it
# answers the arithmetic tersely and fast instead of churning through a
# context-heavy repo. (Also exercises the folder-trust dialog on a fresh dir.)
CLAUDE_CWD="$WORK/cwd"
mkdir -p "$SPOOL" "$RESP" "$CLAUDE_CWD"

echo "=== prove-twoway.sh ==="
echo "ghostty:  $GH"
echo "claude:   $CLAUDE"
echo "workdir:  $WORK"
echo

sk() { node "$SK" --dir "$SPOOL" --resp-dir "$RESP" "$@"; }
matched() { echo "$1" | grep -q '"matched": true'; }
# Tolerant JSON helpers -- empty/partial input (e.g. a CLI-level timeout that
# printed nothing to stdout) must NOT crash the script (CEO-VERIFY-FAIL-1).
summary() { echo "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log("  matched="+j.matched+" reason="+j.reason+" elapsed_ms="+j.elapsed_ms)}catch(e){console.log("  (no/parse-fail response: "+JSON.stringify(s.slice(0,80))+")")}})'; }
field() { echo "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.surface||"").split("\n").filter(l=>l.trim()).slice(-'"$2"').join("\n"))}catch(e){console.log("  (no/parse-fail response)")}})'; }

GPID=""
cleanup() { [ -n "$GPID" ] && kill "$GPID" 2>/dev/null; }
trap cleanup EXIT

# Launch the fork running claude DIRECTLY (clean env, no login shell/tmux), then
# VERIFY the launched instance actually started a watcher by probing it with a
# READ. If the probe never returns, ghostty did not create a watched surface --
# almost always because the launch has no GUI/WindowServer (Aqua) session, e.g.
# it was run from a DETACHED tmux / ssh / background context. We retry a few
# times, then FAIL LOUDLY with that exact diagnosis instead of silently hanging
# (CEO-VERIFY-FAIL-1: a stale/absent surface -> no response -> confusing crash).
launch_and_verify() {
  local attempt probe
  for attempt in 1 2 3; do
    echo "--- launch attempt $attempt ---"
    GHOSTTY_SENDKEYS_DIR="$SPOOL" \
    GHOSTTY_SENDKEYS_RESP_DIR="$RESP" \
    GHOSTTY_LOG=info \
      "$GH" --command="/bin/bash --noprofile --norc -c 'cd \"$CLAUDE_CWD\" && exec \"$CLAUDE\" --dangerously-skip-permissions'" >"$LOG" 2>&1 &
    GPID=$!
    echo "ghostty pid: $GPID -- probing for a live watcher..."
    # Probe: a READ must come back within ~8s if the watcher is running.
    probe="$(sk --id "__probe_${attempt}__" read --lines 1 2>/dev/null)"
    if echo "$probe" | grep -q '"ok": true'; then
      echo "watcher is live (probe answered)."
      return 0
    fi
    echo "no watcher response on attempt $attempt; killing and retrying."
    kill "$GPID" 2>/dev/null; GPID=""; sleep 2
  done
  return 1
}

if ! launch_and_verify; then
  echo
  echo "PROVE-TWOWAY: FAIL  (ghostty never created a WATCHED surface)"
  echo "  The launched ghostty process did not start the sendkeys watcher, so no"
  echo "  READ/WAITFOR response is ever written. This almost always means the"
  echo "  launch has NO GUI / WindowServer (Aqua) session and cannot open a window."
  echo "  launchctl managername = $(launchctl managername 2>/dev/null)"
  echo "  TMUX = ${TMUX:-<none>}"
  echo "  >>> Run this from a REAL GUI terminal (an Aqua login session), NOT from a"
  echo "      detached 'tmux new-session -d' / ssh / background/automation context."
  echo "  (The two-way protocol itself is unit-tested headless: node --test sendkeys.test.js)"
  exit 1
fi

# --- Step 1: handle the trust dialog if it appears ------------------------
echo; echo "--- [1] wait for the trust dialog (if any) ---"
TRUST="$(sk waitfor --contains "trust" --timeout-ms 8000)"
if matched "$TRUST"; then
  echo ">>> trust dialog present -> KEY:enter to accept"
  sk send "KEY:enter" >/dev/null   # send = stage + push (a bare `key` only stages)
else
  echo ">>> no trust dialog (already trusted)"
fi

# --- Step 2: wait for claude to finish booting (retry for robustness) ------
echo; echo "--- [2] wait for claude boot (bypass permissions banner) ---"
BOOT=""
for attempt in 1 2 3; do
  BOOT="$(sk waitfor --contains "bypass permissions" --timeout-ms 40000 --settle-ms 1500)"
  echo "  attempt $attempt:"; summary "$BOOT"
  matched "$BOOT" && break
done
if ! matched "$BOOT"; then
  echo "PROVE-TWOWAY: FAIL  (claude never booted)"
  echo "--- ghostty log tail ---"; tail -n 20 "$LOG" 2>/dev/null
  exit 1
fi

echo; echo "--- [2b] surface snapshot (claude ready) ---"
field "$(sk read --lines 6)" 6

# --- Step 3: ask, wait for the model's answer (ACCEPTANCE) ----------------
echo; echo "--- [3] PROMPT the model (answer '42' is NOT in the prompt) ---"
sk prompt "What is 21 plus 21? Reply with only the number and nothing else." >/dev/null

echo; echo "--- [4] WAITFOR the model's answer '42' (acceptance) ---"
RES="$(sk waitfor --contains "42" --timeout-ms 90000)"
summary "$RES"
echo "--- surface tail ---"; field "$RES" 8

# --- Step 5: full scrollback + screenshot into the report -----------------
echo; echo "--- [5] gettext --all (full scrollback) tail ---"
field "$(sk gettext --all)" 6

echo; echo "--- [6] screenshot the result ---"
SHOT="$ROOT/twoway-notes/prove-twoway-result.png"
mkdir -p "$ROOT/twoway-notes"
sk screenshot "$SHOT" --pid "$GPID" || true
[ -f "$SHOT" ] && echo "screenshot: $SHOT ($(stat -f '%z' "$SHOT" 2>/dev/null) bytes)"

echo
if matched "$RES"; then
  echo "PROVE-TWOWAY: PASS  (drove a claude session end-to-end; Enter submitted in the TUI)"
  exit 0
else
  echo "PROVE-TWOWAY: FAIL  (never observed the model's answer)"
  exit 1
fi
