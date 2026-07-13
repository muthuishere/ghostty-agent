# Sendkeys automation spike — spec

Date: 2026-07-13
Status: spike / proof-of-concept, not upstream Ghostty behavior

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

## Files touched today

| File                                          | Change                                                        |
|------------------------------------------------|----------------------------------------------------------------|
| `src/apprt/surface.zig`                        | New `Message.InjectKey` variant                                |
| `src/Surface.zig`                              | Watcher fields/methods, init/deinit hooks, handleMessage case  |
| `sendkeys.js` (new, repo root)                 | Producer CLI                                                   |
| `ghostty-auto.app` (new symlink, repo root)    | `-> zig-out/Ghostty.app`, stable launch path for scripts/skills |
| `.claude/skills/ghostty-sendkeys/SKILL.md` (new) | Operational runbook for build/launch/inject/verify/cleanup   |
| `SENDKEYS_SPEC.md` (new, this file)            | Design + verification record                                    |

## Explicitly out of scope / not done

- No CLI flag alternative to the `GHOSTTY_SENDKEYS_DIR` env var.
- No real filesystem-event notification (kqueue/inotify) — the watcher
  polls every 25ms. Fine for test automation throughput; not
  "instant."
- No multi-chord sequences per `KEY:` line (one trigger per line).
- Not wired into any CI/test harness — this is a manual/spike tool.
- Not upstreamed or intended for upstream Ghostty; this is a
  fork-local automation-testing feature.
