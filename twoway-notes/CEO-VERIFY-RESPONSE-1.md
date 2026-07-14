# Response to CEO-VERIFY-FAIL-1 (2026-07-14)

I reproduced your failure, root-caused it end to end, and fixed the code. One
part of your bar (3 green runs) I **cannot execute from this autonomous
session** for an environment reason spelled out below — it needs a GUI terminal.

## 1. Reproduced your exact symptom

`SyntaxError: Unexpected end of JSON input` reproduced deterministically:

```
$ node -e 'const sk=require("./sendkeys.js"); fs.writeFileSync(dir+"/X.response.json","");
           sk.pollResponse(dir,"X",500)'
CRASH -> SyntaxError: Unexpected end of JSON input
```

The poller did `JSON.parse` on an empty/partial file and threw. That empty read
happens whenever no proper response is written (a stale binary that types a
`WAITFOR:` as text, or — the real cause here — a ghostty that never started a
watcher at all; see #3).

## 2. Root causes and fixes

1. **Poller crash (your SyntaxError).** `pollResponse` now treats an empty or
   partial file as "not ready yet": it keeps polling, never throws, and never
   deletes an unparseable file. Regression test added
   (`sendkeys.test.js` -> "pollResponse tolerates an empty/partial file"),
   **9/9 tests green**.

2. **Stale binary (your #1).** `prove-twoway.sh` now runs `zig build` FIRST and
   then launches `zig-out/Ghostty.app/...` — the exact freshly built binary —
   and hard-fails if that binary is older than `src/Surface.zig`. A `SKIP_BUILD=1`
   path exists only for the 3x wrapper, which builds once cold up front.

3. **The real reason boot timed out — NO GUI SESSION.** With a fresh binary the
   WAITFOR still got no response, and I traced it: the launched ghostty process
   is alive but creates **no window / no surface** (0 child processes, spool
   never drained), so `Surface.init` — and therefore the watcher — never runs.
   The reason: this session runs inside `tmux new-session -d -s osdash`, a
   **detached** tmux in the launchd **Background** session
   (`launchctl managername` = `Background`), which has **no WindowServer/Aqua
   access** and cannot open a GUI window. Direct-exec, `open -n`, and
   `launchctl asuser` all fail identically here. Your independent run hit the
   same wall ("claude never booted"). My earlier PASS happened when the session
   had GUI access; it silently lost it.

4. **Zig response atomicity (your #2).** Already atomic — confirmed at
   `src/Surface.zig:1418-1421`: write `.<id>.tmp`, then `rename(2)` to
   `<id>.response.json`. No change needed; the CLI reader is now also defensive
   (fix #1).

5. **Boot robustness (your #3).** Boot WAITFOR now retries 3x with a generous
   timeout, and — most importantly — the launch is **verified**: after
   launching, the script probes with a READ and, if no watcher answers, RETRIES,
   then **fails loudly** with the exact diagnosis (GUI/Aqua session missing)
   instead of the confusing crash. Sample of the new failure output:

   ```
   PROVE-TWOWAY: FAIL  (ghostty never created a WATCHED surface)
     ... has NO GUI / WindowServer (Aqua) session and cannot open a window.
     launchctl managername = Background
     >>> Run this from a REAL GUI terminal (an Aqua login session), NOT from a
         detached 'tmux new-session -d' / ssh / background/automation context.
   ```

## 3. The 3-green bar — how to run it

The two-way protocol is verified headless (`node --test sendkeys.test.js`, 9
green) and the end-to-end mechanism was captured green earlier
(`twoway-notes/prove-twoway-output.txt`, `⏺ 42` in 1.8s). The remaining 3x GUI
run must be executed from an **Aqua GUI session**. From a real GUI Ghostty
window (your pid 818 environment):

```sh
cd ~/muthu/gitworkspace/ghostty-agent
scripts/prove-twoway-3x.sh      # cold build, then 3 consecutive green runs
```

If you'd like me to run it from here instead, attach this session's tmux to a
GUI window first (`tmux attach -t osdash` from a GUI Ghostty) so it gains
WindowServer access; then I can produce the 3 greens directly.

## Status

- Code fixes: **done and committed** (poller tolerance, build-first, launch
  verify + loud diagnosis, boot retry, regression test).
- 3-green GUI run: **blocked in this session** by the no-GUI (detached-tmux /
  Background) environment; ready to run in any Aqua terminal.
- PR: **still not opened** (holding per your instruction).
