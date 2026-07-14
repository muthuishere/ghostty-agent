# Sendkeys automation spike — spec

Date: 2026-07-13 (v1, one-way) · 2026-07-14 (v2, two-way)
Status: spike / proof-of-concept, not upstream Ghostty behavior

> **v2 — this feature is now bidirectional.** The v1 sections below describe the
> original write-only key-injection spool (still the substrate, still valid and
> back-compatible). The two-way request→response protocol — an `@<id>` prefix,
> a responses directory, and the `READ` / `WAITFOR` / `PROMPT` verbs — is
> specified in **"Two-way protocol (v2)"** near the end of this file, and is
> also captured as the OpenSpec change `openspec/changes/two-way-sendkeys/`.
> Sibling forks: chromium (`~/muthu/gitworkspace/chromium/CHROMIUM_SENDKEYS_SPEC.md`,
> `results/` + `WAITFOR`) and vscode (`~/muthu/gitworkspace/vscode-agent/SENDKEYS_SPEC.md`,
> `@<id>` result channel) — ours mirrors their shape, adapted to a terminal
> whose readable state is the screen buffer, not a DOM.

## Problem

Automate driving a running Ghostty window from an external test
process — inject keystrokes, run shell commands, exercise keybindings —
without relying on OS-level UI automation (no synthetic OS key events,
no accessibility APIs sending input). The requirement was to do this by
changing Ghostty's own source, so the "keys" travel through Ghostty's
real input pipeline (binding lookup, key remaps, PTY encoding) exactly
like a physical keystroke would, not a shortcut around it.

## Design

### Where it plugs in

Every real key event, regardless of platform (GTK/macOS/embedded),
already gets normalized to one struct, `input.KeyEvent`
(`src/input/key.zig`), and funnelled through one function,
`Surface.keyCallback` (`src/Surface.zig`). That function does binding
lookup, remaps, and PTY encoding. The spike's only job is to get a
synthetic `KeyEvent` into that same function from a source that isn't
a GUI event.

### Cross-thread delivery

The synthetic-key producer is a background OS thread (a file watcher),
but `keyCallback` must run on the surface's main thread — apprt state
(GTK widgets, AppKit views) isn't thread-safe. Ghostty already has a
cross-thread delivery mechanism for exactly this shape of problem: the
surface mailbox (`apprt.surface.Message` + `Surface.handleMessage`,
drained on the main loop via `App.drainMailbox`). The spike adds one
new variant to that existing union rather than inventing a new
mechanism:

```zig
// src/apprt/surface.zig
inject_key: InjectKey,

pub const InjectKey = struct {
    action: input.Action,
    key: input.Key,
    mods: input.Mods = .{},
    utf8: WriteReq = .{ .small = .{} },   // embedded by value (MessageData),
                                           // safe to cross threads
};
```

`WriteReq` (`MessageData(u8, 255)`) is the same small-buffer-embed
pattern already used by `clipboard_write` and `pwd_change` in the same
union — necessary because `KeyEvent.utf8` is normally an unowned slice,
which would dangle if referenced across the thread boundary.

`Surface.handleMessage` dispatches it exactly like a real key event:

```zig
.inject_key => |ik| _ = try self.keyCallback(.{
    .action = ik.action,
    .key = ik.key,
    .mods = ik.mods,
    .utf8 = ik.utf8.slice(),
}),
```

### The watcher

`src/Surface.zig` gained two fields (`sendkeys_thread: ?std.Thread`,
`sendkeys_stop: std.atomic.Value(bool)`) and a block of private
methods, started at the end of `Surface.init` and stopped/joined at
the top of `Surface.deinit`:

- `sendkeysWatcherStart` — reads `GHOSTTY_SENDKEYS_DIR`; no-ops if
  unset; errors if the directory doesn't exist (does not create it).
  Spawns `sendkeysWatcherMain` on a new `std.Thread`.
- `sendkeysWatcherMain` — loop until `sendkeys_stop`; calls
  `sendkeysWatcherDrain` each iteration; only sleeps (25ms) if a pass
  found nothing, so a burst of queued files drains back-to-back.
- `sendkeysWatcherDrain` — lists the directory, skips dotfiles
  (reserved for producer staging) and non-regular files, sorts
  remaining names, processes each in order.
- `sendkeysWatcherProcessFile` — reads a file's full contents,
  **deletes it before dispatching** (at-most-once delivery — a crash
  mid-file can't replay it forever, which matters more for input
  injection than losing an occasional stuck event would), then splits
  it into lines.
- `sendkeysProcessLine` — dispatches by prefix: `KEY:` →
  `sendkeysInjectTrigger`, `TEXT:` or bare → `sendkeysInjectText`.
- `sendkeysInjectTrigger` — parses the trigger with
  `input.Binding.Trigger.parse` (the exact same parser used for config
  `keybind = ...` lines), so `KEY:` lines use identical syntax to a
  real keybind trigger (`ctrl+c`, `cmd+shift+t`, `enter`). Sends a
  press then a release.
- `sendkeysInjectText` — iterates Unicode codepoints; maps ASCII via
  `input.Key.fromASCII` (lowercased, since the physical-key enum is
  shift-independent) with `\n`/`\r` → `.enter` (utf8 `"\r"`) and `\t` →
  `.tab` special-cased; sends a press+release per codepoint.
- `sendkeysInject` — builds the `InjectKey` message and pushes it via
  the pre-existing `surfaceMailbox().push(msg, .{ .forever = {} })`.

### Why a spool directory, not a single tailed file

The first iteration tailed one growing file
(`GHOSTTY_SENDKEYS_FILE`), tracking a byte offset. That doesn't scale
to multiple concurrent producers (shared offset/cursor contention,
torn writes if two processes `>>` append at once). It was replaced
with a spool **directory** (`GHOSTTY_SENDKEYS_DIR`):

- Any number of producers write their own uniquely-named files
  independently — no shared cursor.
- Producers **must** publish atomically: stage content outside the
  directory (or as a dotfile inside it — the watcher ignores names
  starting with `.`), then `rename()` into place. `rename(2)` is
  atomic on POSIX, so the watcher can never observe a half-written
  file.
- Files are processed in sorted-filename order, then deleted.

## Producer-side CLI

`sendkeys.js` (repo root) — small, dependency-free Node script, the
producer counterpart to the directory protocol:

```
sendkeys.js --dir <spool>  add  <TEXT:...|KEY:...|literal>   stage a line
sendkeys.js --dir <spool>  type <text>                        stage a TEXT: line
sendkeys.js --dir <spool>  key  <combo>                       stage a KEY: line
sendkeys.js --dir <spool>  send <TEXT:...|KEY:...|literal>   stage + push in one call
sendkeys.js --dir <spool>  push                               publish atomically
```

`add`/`type`/`key` append to `.ghostty-sendkeys-staging` inside the
target directory; `push` does `fs.renameSync` to a
`<Date.now()>-<pid>-<random>.txt` name. `--dir` falls back to
`$GHOSTTY_SENDKEYS_DIR`.

## Build notes discovered along the way

- This tree pins Zig 0.15.2 (`build.zig.zon`); the machine's default
  Homebrew `zig` was 0.16.0 and failed the version gate immediately.
  Installed a pinned keg: `brew install zig@0.15`, invoked explicitly
  as `/opt/homebrew/opt/zig@0.15/bin/zig`.
- Building the full macOS app the first time needed the Xcode Metal
  Toolchain (`xcodebuild -downloadComponent MetalToolchain`, ~688MB) —
  missing by default, `metal` shader compilation fails without it.
- `-Doptimize=ReleaseFast` (or `ReleaseSafe`/`ReleaseSmall`) maps to
  Xcode configuration `ReleaseLocal` (`src/build/GhosttyXcodebuild.zig`),
  landing at `macos/build/ReleaseLocal/Ghostty.app`, then copied to
  `zig-out/Ghostty.app` — same install path as debug, so bundle size
  (release is meaningfully smaller, no debug symbols) is the quick way
  to confirm which config you actually have.
- A repo-root symlink, `ghostty-auto.app -> zig-out/Ghostty.app`, gives
  a stable launch path for scripts/skills regardless of which config
  was last built (the target itself gets overwritten every build, the
  symlink doesn't need to change). Confirmed it resolves bundle
  resources and launches identically to the real path.
- The **first** build of a new Xcode configuration via `zig build`
  failed with exit 65, because `GhosttyXcodebuild.zig` runs `xcodebuild`
  with a deliberately stripped env (PATH only). Running `xcodebuild
  -target Ghostty -configuration ReleaseLocal` directly once (full
  shell env) let Xcode bootstrap that configuration; `zig build
  -Doptimize=ReleaseFast` succeeded on the next attempt (~71s).

## Verification performed

1. Built debug, launched via `GHOSTTY_SENDKEYS_FILE` (first iteration),
   confirmed `TEXT:`/`KEY:enter` lines typed a real shell command and
   executed it (screenshot showed `echo sendkeys-spike-ok` typed and
   its output printed).
2. Rebuilt after switching to the directory design
   (`GHOSTTY_SENDKEYS_DIR`), re-verified the same way with files
   published from two concurrent backgrounded shell subprocesses using
   the atomic stage-then-rename convention.
3. Built `sendkeys.js`, used `type`/`key`/`push` against the same
   running instance, confirmed the pushed file was consumed (deleted)
   within ~1s — consistent with the mechanism already verified
   visually in step 2.
4. Built a ReleaseFast binary and confirmed it's a real, distinct build
   (fresh mtime, ~65MB vs ~140MB+ debug, universal x86_64+arm64
   Mach-O).

## Known gotcha (process, not code)

Using `osascript ... "first process whose unix id is $PID"` to raise a
specific Ghostty window for a screenshot proved unreliable on this
machine — it once brought forward a *different*, unrelated Ghostty
window/tab instead of the spike instance, risking a screenshot of
unrelated session content. Avoid blind full-screen `screencapture` for
verification; prefer directory-state checks (file appears then
disappears) or a deliberately-resolved window ID.

## Protocol summary (quick reference)

| Env var                 | Effect                                                             |
|--------------------------|---------------------------------------------------------------------|
| `GHOSTTY_SENDKEYS_DIR`   | Enables the watcher; must point at an existing directory           |
| `GHOSTTY_LOG=info`       | Optional — emits `sendkeys watcher started/stopped` log lines       |

| Spool file line   | Effect                                                              |
|--------------------|-----------------------------------------------------------------------|
| `TEXT:<text>`      | Types `<text>`, one synthetic key event per Unicode codepoint         |
| `KEY:<trigger>`    | Press+release of one chord; syntax identical to a config `keybind`    |
| *(bare line)*      | Treated as `TEXT:`                                                     |

Constraints: `\n` is always the file's line separator (a `TEXT:` line
can never itself contain a literal Enter — send a separate `KEY:enter`
line); files must be published via atomic rename, never appended to
directly inside the watched directory; delivery is at-most-once
(file is deleted before its lines are dispatched).

## Two-way protocol (v2)

v1 was write-only: a driver could inject keys but was **blind** — it could not
tell a "trust this folder" dialog from a ready prompt from a finished answer, so
it had to guess with fixed sleeps. v2 makes the channel **bidirectional**: a
request may ask for a result, and the watcher writes that result back into a
**responses directory** the producer polls. This is the terminal analogue of
chromium's `results/` + `WAITFOR` and vscode's `@<id>` result channel; the
difference is the readable state — a terminal's is the **screen buffer**
(`Terminal.plainString`), not a DOM.

### Request identity: the optional `@<id>` prefix

Any request line MAY begin with `@<id> ` — an id matching `[A-Za-z0-9._-]+`
followed by exactly one space:

```
@<id> <VERB>[:<payload>]
```

If the prefix is present the watcher writes exactly one response file for that
request; if it is absent the line is fire-and-forget, byte-for-byte the v1
behavior. This vscode-style prefix (rather than chromium's embedded
`VERB:<id>|<payload>`) was chosen so **every existing verb's payload grammar is
unchanged** — an id never has to be squeezed into a `TEXT:`/`KEY:` payload — and
so even one-way verbs can opt into a delivery ack for free.

### The responses directory

Responses land in `GHOSTTY_SENDKEYS_RESP_DIR` if set, else `<spool>/responses/`
(a subdirectory of the spool). The watcher creates it lazily on first write
(`makePath`), so the producer needn't pre-create it. It is **never scanned as an
input source**: `sendkeysWatcherDrain` already skips any dir entry whose
`kind != .file`, so a `responses/` subdirectory is invisible to the input drain
— no collision between the two directions (same trick chromium uses for
`results/`).

Each response is published **atomically**: written to `<resp_dir>/.<id>.tmp`,
then `rename(2)`d to `<resp_dir>/<id>.response.json`. `rename` is atomic on
POSIX, so a producer polling for `<id>.response.json` never sees a torn file —
the input spool's atomicity invariant, applied in reverse. The producer polls,
reads, then deletes the file (no server-side GC — an unread response lingers).

### New verbs

| Line | Effect | Response JSON |
|---|---|---|
| `READ` / `READ:<lines>` | Snapshot the visible viewport as plain text; `<lines>` keeps only the last N lines | `{id, ok:true, verb:"read", surface, lines}` |
| `READ:all` | Snapshot the FULL scrollback + viewport (`.screen`), not just visible rows | `{id, ok:true, verb:"read", surface, lines}` |
| `WAITFOR:<timeout_ms>\|<settle_ms>\|<needle>` | Block until surface contains `<needle>`, or output quiet for `settle_ms`, or `timeout_ms` elapses | `{id, ok:true, verb:"waitfor", matched, reason, elapsed_ms, surface}` |
| `PROMPT:<text>` | Type `<text>`, pause, then Enter as one atomic request (TUI-safe submit — see "The Enter bug") | `{id, ok:true, verb:"prompt", delivered:true}` |
| `TEXT:<text>` / `KEY:<trigger>` (with `@<id>`) | Inject as v1, plus a delivery ack | `{id, ok:true, verb:"text"\|"key", delivered:true}` |

`screenshot` is a **producer-side** verb (no watcher round-trip): the CLI captures
a PNG of the ghostty window via macOS `screencapture`, resolving the window by
owner PID — see "Screenshot" below.

`WAITFOR`'s `<needle>` is the entire remainder of the line after the second `|`,
so it may itself contain `|`. Empty `timeout_ms` defaults to 30000; empty
`settle_ms` defaults to 0 (settle disabled). `reason` is one of `"contains"`
(needle found), `"settled"` (output quiet for `settle_ms`), or `"timeout"`;
`matched` always reflects whether `<needle>` is in the final snapshot.

### Where the surface text comes from, and why it's thread-safe

The terminal screen is `self.renderer_state.terminal` (a `*terminal.Terminal`),
and `Terminal.plainString(alloc)` (`src/terminal/Terminal.zig`) dumps the active
screen's **viewport** to UTF-8 via `Screen.dumpStringAlloc(alloc, .{ .viewport
= .{} })`. That buffer is guarded by `renderer_state.mutex` — the *same* mutex
the IO thread (`src/termio/Thread.zig:150`, `src/termio/Termio.zig`) and the
renderer take before touching `terminal`.

So the key safety decision (D1 in the design): **reads run directly on the
watcher thread under `renderer_state.mutex`**, not through the mailbox.
Injection has to cross to the main thread because AppKit/GTK state isn't
thread-safe (hence `.inject_key` via the mailbox), but a *read* only needs the
terminal mutex, exactly as the renderer does:

```zig
fn sendkeysSnapshot(self: *Surface, alloc: Allocator) ![]u8 {
    self.renderer_state.mutex.lock();
    defer self.renderer_state.mutex.unlock();
    return try self.renderer_state.terminal.plainString(alloc); // owned copy
}
```

The snapshot is copied into an owned buffer before the lock is released, so
nothing dangles once the IO thread resumes mutating the screen. Going through
the mailbox instead was rejected: the mailbox is one-way (fire-and-forget) and
can't return a value to the watcher thread, and the mutex already makes a direct
read safe — a mailbox hop would add an async round-trip for no safety gain.

### `WAITFOR` blocks the watcher thread — on purpose

`WAITFOR` loops on the watcher thread, re-snapshotting every ~50ms, and while it
runs no other spool files drain (head-of-line blocking). This is the correct
semantics, not a bug: a driver issues request→response **sequentially** (it
waits for `<id>.response.json` before sending the next request). Injection is
unaffected — it flows through the mailbox to the main thread independently, and
terminal output flows from the IO thread — so the surface genuinely changes
while `WAITFOR` polls it. Settle detection compares two snapshots `settle_ms`
apart: byte-equal ⇒ output quiet ⇒ return `reason:"settled"`.

### Delivery ack semantics (stated plainly)

The ack for `TEXT`/`KEY`/`PROMPT` fires once the synthetic events are **queued
to the surface mailbox** — it means "request accepted/queued", not "effect
rendered". Confirming the effect actually landed is exactly what `WAITFOR` is
for. Don't read an ack as proof the shell saw the keys.

### The Enter bug — why a raw KEY:enter doesn't submit in a TUI (and the fix)

**Symptom (owner-reported, reproduced):** driving a plain shell, `TEXT:` + a
separate `KEY:enter` runs the command fine. Driving a **Claude Code** session,
the injected prompt text lands in Claude's input box and then just *sits there*
— Enter never submits it.

**Root cause #1 — the paste-burst.** Our text injection fires one synthetic key
event per codepoint with no pacing, so the whole line reaches the PTY as a
single fast burst. Claude Code (an Ink/React TUI) runs paste-detection: input
arriving as one fast chunk is treated as a *paste*, and a `\r` inside a paste is
inserted as a literal newline, **not** a submit. A plain shell has no such
heuristic, which is exactly why v1 "worked" on a shell but not in the TUI. **Fix:**
`PROMPT` injects the text, sleeps `GHOSTTY_SENDKEYS_ENTER_DELAY_MS` (default
**250ms**), then injects Enter as a *distinct, later* keypress — so the TUI sees a
lone Return and submits. (A bare `KEY:enter` on its own — e.g. accepting a
trust/menu dialog — has no preceding text burst and already submits fine; the
bug is specific to text-immediately-followed-by-Enter, which is what `PROMPT`
now handles correctly.)

**Root cause #2 — the operator's noisy shell stack.** The operator's login shell
auto-attaches **tmux** (and runs direnv). Launching the fork's default shell
therefore yields a `ghostty → zsh → tmux → claude` stack in which injected input
was routed to the **zsh** layer (observed: `zsh: no matches found: 21?` from the
prompt text hitting the shell) and the active screen flapped between tmux/alt and
the primary buffer, making reads non-deterministic. **Fix:** drive Claude as
ghostty's **own PTY process** in a clean environment, bypassing the login shell
entirely:

```sh
ghostty --command="/bin/bash --noprofile --norc -c 'cd <empty-dir> && exec claude --dangerously-skip-permissions'"
```

`--command` replaces the login shell, `--noprofile --norc` skips the tmux/direnv
rc, and `exec claude` makes Claude the foreground PTY leader so every injected
keystroke reaches Claude directly. With both fixes, `prove-twoway.sh` reliably
drives a real Claude session: `PROMPT "What is 21 plus 21? ..."` →
`WAITFOR "42"` matches in ~1.8s (the answer `42` is absent from the prompt, so a
match can only be Claude's own output — proof that Enter submitted in the TUI).

### Full scrollback: `READ:all` / `gettext --all`

`READ` (and `READ:<lines>`) snapshots the visible viewport (`.viewport`).
`READ:all` snapshots the entire written screen including scrollback (`.screen`),
via `Screen.dumpStringAlloc(alloc, .{ .screen = .{} })` under the same mutex.
(Note: a TUI on the *alternate* screen — like Claude — has no scrollback, so
`READ:all` ≈ `READ` there; the distinction matters for shell sessions.)

### Screenshot (producer-side, macOS)

`screenshot <path> [--pid <ghostty pid>]` is handled entirely in the CLI — it
does not touch the spool/watcher. It resolves the ghostty window's CGWindowID by
owner PID (a JXA/ObjC-bridge `CGWindowListCopyWindowInfo` query, deterministic by
PID — unlike the flaky "System Events window by pid" the v1 SKILL warned about)
and captures it with `screencapture -o -l<id>`; if the window can't be resolved
it falls back to a full-screen grab. **Caveat:** on macOS Sonoma+, capturing (and
even *enumerating* other apps') windows requires **Screen Recording permission**
for the invoking terminal — without it, window resolution returns nothing (falls
back to full-screen) and captured pixels may be blank. For a terminal, the
authoritative visual state is the text itself (`read` / `gettext --all`); the PNG
is a convenience per the owner's "window-level PNG is acceptable" allowance.

### Producer CLI (v2 additions)

`sendkeys.js` gains id generation, response polling, and new subcommands:

```
sendkeys.js --dir <spool> read    [--lines N | --all]                 → prints surface JSON
sendkeys.js --dir <spool> gettext --all                               → full scrollback (alias)
sendkeys.js --dir <spool> waitfor --contains <t> [--timeout-ms N] [--settle-ms N]
sendkeys.js --dir <spool> prompt  <text>                              → type + Enter, ack
sendkeys.js --dir <spool> type|key|send <...> [--wait]                → v1 + optional ack
sendkeys.js --dir <spool> screenshot <path> [--pid <ghostty pid>]     → PNG (macOS, local)
```

Note: bare `type`/`key` **stage** only (v1 semantics); `send` and the two-way
verbs publish immediately. Use `send "KEY:enter"` (not `key enter`) to fire a
one-off Enter, e.g. to accept a trust dialog.

Two-way subcommands generate an id, push `@<id> <VERB>...`, then **poll**
`<resp_dir>/<id>.response.json` (default `<spool>/responses`, override
`--resp-dir` / `$GHOSTTY_SENDKEYS_RESP_DIR`), delete it once read, and print it —
the same polling philosophy as the watcher itself (no push either direction).
`--wait` on the v1 verbs opts them into an id + ack.

### v2 protocol summary (quick reference)

| Env var                          | Effect                                                        |
|-----------------------------------|----------------------------------------------------------------|
| `GHOSTTY_SENDKEYS_DIR`            | Enables the watcher; must point at an existing directory       |
| `GHOSTTY_SENDKEYS_RESP_DIR`       | *Optional* override of the responses dir (default `<spool>/responses`) |
| `GHOSTTY_SENDKEYS_ENTER_DELAY_MS` | *Optional* text→Enter separation for `PROMPT` (default 250; see "The Enter bug") |
| `GHOSTTY_LOG=info`                | Optional — emits watcher start/stop + dispatch log lines        |

Constraints carried over from v1: `\n` is always the line separator; input files
are published via atomic rename, never appended in-place; input delivery is
at-most-once (file deleted before dispatch). New in v2: responses are published
via atomic rename too; `WAITFOR` is sequential/blocking; ids are
`[A-Za-z0-9._-]+`.

## Files touched today

| File                                          | Change                                                        |
|------------------------------------------------|----------------------------------------------------------------|
| `src/apprt/surface.zig`                        | New `Message.InjectKey` variant (v1)                           |
| `src/Surface.zig`                              | v1 watcher; **v2**: `@<id>` parse, responses dir, `sendkeysSnapshot`, `READ`/`WAITFOR`/`PROMPT`, `sendkeysWriteResponse` |
| `sendkeys.js` (repo root)                      | Producer CLI; **v2**: `read`/`waitfor`/`prompt`, id + response polling |
| `sendkeys.test.js` (new, repo root)            | Headless CLI request/response encode + waitfor timeout tests   |
| `scripts/prove-twoway.sh` (new)                | End-to-end proof: drive a real `claude` session via v2 verbs   |
| `ghostty-auto.app` (symlink, repo root)        | `-> zig-out/Ghostty.app`, stable launch path                   |
| `openspec/changes/two-way-sendkeys/` (new)     | OpenSpec change (proposal, design, spec delta, tasks)          |
| `.claude/skills/ghostty-sendkeys/SKILL.md`     | v2 two-way verbs runbook                                        |
| `SENDKEYS_SPEC.md` (this file)                 | v1 design + v2 two-way protocol                                 |

## Explicitly out of scope / not done

- No CLI flag alternative to the `GHOSTTY_SENDKEYS_DIR` env var.
- No real filesystem-event notification (kqueue/inotify) — the watcher
  polls every 25ms. Fine for test automation throughput; not
  "instant."
- No multi-chord sequences per `KEY:` line (one trigger per line).
- Not wired into any CI/test harness — this is a manual/spike tool.
- Not upstreamed or intended for upstream Ghostty; this is a
  fork-local automation-testing feature.
