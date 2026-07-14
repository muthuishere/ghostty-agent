# Response to CEO-VERIFY-FAIL-1 — reproduced, root-caused, fixed, 3/3 green (2026-07-14)

## I reproduced your FAIL
On a **fresh** cold build (so NOT the stale-binary path you flagged), RUN 1 still failed:
```
--- [2] wait for claude boot --- attempt 1/2/3: matched=false reason=settled elapsed_ms=~1500
PROVE-TWOWAY: FAIL (claude never booted)
```
Same signature as yours ("claude never booted"), so it was a *second*, independent bug
underneath the stale-binary one.

## Root cause (a surface race, not a stale binary)
I drove a live session by hand and watched the surface flip between reads:
- read at T+2s → claude booted (`bypass permissions on`)
- read at T+6s → a **different** surface, fresh `Last login … ttysNNN`, still on the trust dialog

The fork process had **two watched surfaces**. macOS window **state-restoration** reopens a
prior window in the same process; that restored surface *also* inherits `GHOSTTY_SENDKEYS_DIR`
and starts its **own** watcher. Two watchers then race to drain the single spool dir, so each
READ/WAITFOR is answered by whichever surface grabbed the request first — sometimes the
booted-claude surface, sometimes the stale restored one. When the boot WAITFOR kept landing on
the static restored surface it "settled" with no match → "claude never booted".

Proof: with `--window-save-state=never`, 8 consecutive reads all returned the *same* surface
(no flip); without it, they flipped.

## Fix
`scripts/prove-twoway.sh` now launches with **`--window-save-state=never`**, so exactly ONE
watched surface exists per launch. Targeted one-line fix at the source (the extra surface),
not a workaround in the reader.

(Your other three points were already satisfied by the prior commit and I re-confirmed each:
build-first + stale-binary guard in prove-twoway.sh; the **Zig** watcher writes responses
atomically via `.<id>.tmp` + `rename` into the resp dir — `Surface.zig:sendkeysWriteResponse`;
the CLI reader treats empty/partial JSON as "not ready, keep polling" and never deletes an
unparseable file — `sendkeys.js:pollResponse`.)

## New acceptance bar MET: 3/3 green from one cold build
`scripts/prove-twoway-3x.sh` → full log in `prove-twoway-3x-output.txt`:
```
RUN 1: boot matched 119ms → prompt → ⏺ 42 (1534ms)  → GREEN
RUN 2: boot matched 107ms → prompt → ⏺ 42 (2021ms)  → GREEN
RUN 3: boot matched 110ms → prompt → ⏺ 42 (1855ms)  → GREEN
RESULT: 3/3 green — ACCEPTANCE: 3/3 GREEN
```
Each run drove a real `claude --dangerously-skip-permissions` session that actually answered
`42` (which is not in the prompt), proving Enter submitted in the TUI. Screenshot:
`prove-twoway-result.png`.
