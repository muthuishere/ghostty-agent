---
name: ghostty-sendkeys
description: Build this Ghostty fork (debug or release), launch an instance with the GHOSTTY_SENDKEYS_DIR automation-testing watcher enabled, and inject synthetic keystrokes into it via a spool directory or the sendkeys.js CLI. Use for automation testing of this repo's fork, not upstream Ghostty.
---

# ghostty-sendkeys

This repo (a fork of Ghostty) has a spike feature baked into the source
for automation testing: a background thread in every `Surface` can tail
a spool **directory** for files describing synthetic key events and
inject them into that surface exactly as if they were typed — real
keybinding lookup, real PTY encoding, no OS-level keystroke automation
involved. Trigger this skill for anything like "start ghostty with
sendkeys", "inject keys into ghostty for testing", "build a release of
this ghostty fork", "test the sendkeys watcher", or "open a ghostty
instance I can script".

## Source of truth

- `src/apprt/surface.zig` — `Message.InjectKey` (action/key/mods/utf8,
  embedded by value so it's safe across the mailbox).
- `src/Surface.zig` — `sendkeys_thread`/`sendkeys_stop` fields; started
  in `init()`, stopped+joined in `deinit()`; `sendkeysWatcherStart`,
  `sendkeysWatcherMain`, `sendkeysWatcherDrain`,
  `sendkeysWatcherProcessFile`, `sendkeysProcessLine`,
  `sendkeysInjectTrigger`, `sendkeysInjectText`, `sendkeysInject`; a
  `.inject_key` case in `handleMessage`.
- `sendkeys.js` (repo root) — the producer-side CLI.

Read those before changing behavior — this doc describes how to *use*
the feature, not a spec to re-derive it from.

## Step 1 — build

**Zig version matters.** This repo pins `minimum_zig_version` in
`build.zig.zon` (0.15.2 as of this writing) but the machine's default
`zig` on PATH may be newer (e.g. Homebrew's `zig` formula tracks HEAD).
A version mismatch fails immediately in `build.zig` with `Your Zig
version vX does not meet the required build version`. Check first:

```sh
zig version
cat build.zig.zon | grep minimum_zig_version
```

If they don't match, install the pinned version as a separate keg
rather than fighting the default one:

```sh
brew install zig@0.15   # or whatever build.zig.zon currently pins
/opt/homebrew/opt/zig@0.15/bin/zig version   # use this binary explicitly throughout
```

**Debug build** (fast iteration, default):

```sh
zig build                              # full build incl. macOS app + xcframework
zig build -Demit-macos-app=false -Demit-xcframework=false   # Zig-only, no GUI — use to
                                        # fast-check that Zig source changes compile
```

**Release build:**

```sh
zig build -Doptimize=ReleaseFast
```

`-Doptimize` only changes the Zig-compiled core (`libghostty-internal`).
The macOS app shell itself is a separate Xcode/Swift project under
`macos/`, and `src/build/GhosttyXcodebuild.zig` maps the Zig optimize
level to an Xcode configuration: `Debug` stays `Debug`; `ReleaseFast`/
`ReleaseSafe`/`ReleaseSmall` all map to **`ReleaseLocal`**. That build
lands at `macos/build/ReleaseLocal/Ghostty.app` and gets copied to
`zig-out/Ghostty.app` (same install path as debug — it's overwritten,
not versioned by config name).

**Known gotcha — first ReleaseLocal build via `zig build` can fail
with exit 65 even though nothing is wrong:** `GhosttyXcodebuild.zig`
invokes `xcodebuild` with a deliberately stripped-down env (only
`PATH` preserved, to avoid ambient env vars corrupting the build). The
very first time a new Xcode configuration (`ReleaseLocal`) is built,
that stripped env can be insufficient (SDK stat cache / provisioning
bootstrap). Fix: run `xcodebuild` directly once with your normal shell
env so it warms up that Xcode configuration, then retry via `zig
build` — it'll succeed immediately after (usually ~60-90s of real
compile work):

```sh
cd macos && xcodebuild -target Ghostty -configuration ReleaseLocal
cd .. && zig build -Doptimize=ReleaseFast   # now succeeds
```

**Missing Metal Toolchain:** if you see `cannot execute tool 'metal'
due to missing Metal Toolchain`, run
`xcodebuild -downloadComponent MetalToolchain` once (multi-hundred-MB
download, needs Xcode already installed) — confirm with the user
before doing this, it's a real download.

**Result either way:** `zig-out/Ghostty.app/Contents/MacOS/ghostty` is
the Mach-O binary (universal x86_64+arm64). Debug is ~140MB+; a
ReleaseFast build of the same tree is meaningfully smaller (no debug
symbols) — that size difference is a quick sanity check that you
actually got a release binary, since the install path is identical
between configs.

A repo-root symlink, `ghostty-auto.app -> zig-out/Ghostty.app`, always
points at whichever config was built most recently — use it as the
stable launch path in scripts/skills instead of hardcoding
`zig-out/Ghostty.app` (that target is overwritten on every build, but
the symlink itself never needs updating). Verified it launches and
resolves bundle resources correctly through the symlink, same as the
real path.

## Step 2 — launch an instance with the watcher enabled

The watcher only starts if `GHOSTTY_SENDKEYS_DIR` is set **and the
directory already exists** — `sendkeysWatcherStart` fails loudly rather
than silently polling nothing, and does not create the dir for you.

```sh
SPOOL_DIR=/path/to/spool   # anywhere; scratchpad is fine for throwaway runs
mkdir -p "$SPOOL_DIR"

GHOSTTY_SENDKEYS_DIR="$SPOOL_DIR" \
  ./ghostty-auto.app/Contents/MacOS/ghostty \
  > /tmp/ghostty-spike.log 2>&1 &
disown
echo $! > /tmp/ghostty-spike.pid   # keep this — you'll need it to clean up
```

Notes:
- Launch the Mach-O binary directly, not `open -a` — `open` does not
  reliably forward custom env vars to the launched app process.
- This opens a real window against your **normal, unmodified config**
  (no `--config-file` override needed) — the point of the spike is to
  exercise the real app, not a sandboxed one.
- Add `GHOSTTY_LOG=info` (or `debug`) to the launch env if you want to
  confirm startup via logs: look for `sendkeys watcher started
  dir=...` in the redirected log file. Without `GHOSTTY_LOG` set,
  Ghostty's default log level won't emit that line even though the
  watcher is running fine.
- Multiple instances can run concurrently, each with its own
  `$SPOOL_DIR` — the env var only affects the process it's set for.

## Step 3 — send keys

Two line formats inside any spool file, one event per line:

```
TEXT:hello world      types the literal text, one key event per Unicode rune
KEY:ctrl+c            press+release of a single chord — same syntax as a
                       config `keybind` trigger (ctrl+c, cmd+shift+t, enter, ...)
```

A bare line with no prefix is treated as `TEXT`. **`\n` is always the
line separator inside a spool file — a `TEXT:` line can never itself
contain a literal Enter.** Always send a separate `KEY:enter` line/file
to press Enter after typing a command.

### Preferred: the `sendkeys.js` CLI (repo root)

```sh
node sendkeys.js --dir "$SPOOL_DIR" type "echo hello"
node sendkeys.js --dir "$SPOOL_DIR" key enter
node sendkeys.js --dir "$SPOOL_DIR" push       # publishes everything staged so far

# or one-shot:
node sendkeys.js --dir "$SPOOL_DIR" send "TEXT:echo hello"
```

`add`/`type`/`key` append to a `.ghostty-sendkeys-staging` dotfile (the
Zig watcher ignores dotfiles by design); `push` does an
`fs.renameSync` into the spool dir under a
`<timestamp>-<pid>-<random>.txt` name — atomic on the same filesystem,
so Ghostty's poller (every ~25ms) never sees a half-written file.
`--dir` falls back to `$GHOSTTY_SENDKEYS_DIR` if omitted.

### Manual (no CLI): same atomic-publish rule applies

```sh
printf 'TEXT:echo hello\n' > "$SPOOL_DIR/.tmp-$$"
mv "$SPOOL_DIR/.tmp-$$" "$SPOOL_DIR/0001.txt"     # atomic rename — required
printf 'KEY:enter\n' > "$SPOOL_DIR/.tmp2-$$"
mv "$SPOOL_DIR/.tmp2-$$" "$SPOOL_DIR/0002.txt"
```

Never `>>` append directly into a non-dot file inside the watched
directory — the watcher can (and, under load, will) read it
mid-write. Always stage elsewhere or as a dotfile, then rename.

Scales to many concurrent producers: each writes its own uniquely
named file, no shared offset/cursor to contend over. Files are
processed in sorted-filename order, then deleted (at-most-once
delivery — a stuck/crashed producer can't replay an event forever).

## Step 4 — verify

The spool file disappearing within ~1s (deleted after being read) is
itself proof of delivery — check with `ls "$SPOOL_DIR"` before/after a
push. For genuine functional proof, the injected `TEXT:`/`KEY:enter`
should actually execute in the real shell running inside that Ghostty
window (it goes through the real PTY, not a mock).

**Do not use `osascript ... "first process whose unix id is $PID"` to
raise the window for a screenshot.** On this machine it proved
unreliable and once activated a *different*, unrelated Ghostty
window/tab — risking a screenshot of unrelated session content. If you
need a visual check:
- Prefer asking the user to glance at the window themselves, or
- Resolve the window's actual `CGWindowID` deliberately (e.g. via
  `System Events` `id of window` scoped by matched title, not just
  PID) and use `screencapture -l<id>` for a scoped capture — never a
  blind full-screen `screencapture -x` when other windows may be on
  screen.
- Otherwise, rely on log output (`GHOSTTY_LOG=info`) and the
  spool-file-disappears check above; that's usually sufficient.

## Step 5 — clean up

```sh
kill "$(cat /tmp/ghostty-spike.pid)"
```

Don't leave spike instances running after you're done testing — they
're indistinguishable from a real user's Ghostty window in `ps aux`
except by the command's env/args, so track the PID from launch and
kill it explicitly.
