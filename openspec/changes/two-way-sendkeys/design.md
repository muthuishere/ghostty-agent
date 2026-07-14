## Context

The one-way sendkeys watcher (`src/Surface.zig`) is a background thread that
drains a spool directory and marshals synthetic `KeyEvent`s onto the surface's
main thread via the existing surface mailbox (`.inject_key`). It is
fire-and-forget. To become a driver the agent can trust, it needs to *read* the
terminal and *wait* on its state.

Two sibling forks already solved the "make sendkeys two-way" problem and their
shape is the template we deliberately follow:

- **chromium** (`CHROMIUM_SENDKEYS_SPEC.md`): `EVAL`/`WAITFOR` write results into
  a `results/` subdir of the spool; the producer polls for `<id>.json`, reads,
  deletes. `WAITFOR:<ms>|<id>|<js>` polls a JS expression every 100ms.
- **vscode** (`SENDKEYS_SPEC.md`): an `@<id>` prefix on a spool line opts that
  line into a `.result.json` companion; `{ok, value?, error?}` per id.

Ours is a **terminal**, so the readable state is not a DOM — it is the surface's
screen buffer (scrollback + viewport of cells). The terminal already exposes
`Terminal.plainString(alloc)` → the viewport as UTF-8, and it is guarded by the
same `renderer_state.mutex` the IO and render threads take.

## Goals / Non-Goals

**Goals:**
- Request→response correlation by caller-supplied `id`, atomic response files.
- `READ` (snapshot the visible surface), `WAITFOR` (block on surface text with a
  settle/timeout fallback), `PROMPT` (type + Enter atomically), all returning a
  response.
- 100% back-compat: existing `TEXT:`/`KEY:`/bare lines behave identically; an
  `@<id>` prefix is purely additive.
- Thread-safe snapshotting — never race the render/IO thread.
- Wire-format parity in spirit with the sibling forks (id-correlated response
  files polled by the producer).

**Non-Goals:**
- No push/socket notification — the producer polls for the response file, same
  as chromium/vscode. 25ms watcher poll, ~50ms waitfor poll.
- No structured cell attributes (fg/bg/styles) — plain text only (`plainString`).
- No multi-surface targeting — single active surface, same as the one-way spike.
- No response TTL/GC — an unread response file lingers (documented limitation).

## Decisions

### D1 — Reads run on the watcher thread under `renderer_state.mutex`, not via the mailbox

Injection must cross to the main thread (AppKit/GTK state is not thread-safe), so
it goes through the mailbox. **Reads are different**: the terminal screen is
guarded by `renderer_state.mutex`, which the IO thread
(`src/termio/Thread.zig:150`, `src/termio/Termio.zig`) and the renderer both
take before touching `terminal`. The watcher thread can therefore lock that same
mutex, call `self.renderer_state.terminal.plainString(alloc)`, unlock, and get a
consistent snapshot — exactly what the renderer does. This avoids inventing a
mailbox round-trip that would have to return a value to the watcher thread
(the mailbox is one-way, fire-and-forget). Alternative considered: post a
"snapshot request" through the mailbox and have the main thread write the
response. Rejected — more moving parts, an extra async hop, and no safety win
(the mutex already makes a direct read safe).

### D2 — `@<id>` line prefix (vscode-style), not an `EVAL:<id>|…` embedded id (chromium-style)

An optional leading `@<id> ` (id then one space) on *any* line opts it into a
response. This keeps every existing verb's payload grammar byte-for-byte
unchanged (a chromium-style `VERB:<id>|<payload>` would have forced an id into
`TEXT:`/`KEY:` payloads and broken back-compat). It also lets one-way verbs
(`TEXT`/`KEY`/`PROMPT`) opt into a *delivery ack* for free. `id` charset is
`[A-Za-z0-9._-]+`.

### D3 — Response directory: `<spool>/responses/`, overridable by `GHOSTTY_SENDKEYS_RESP_DIR`

A subdirectory of the spool by default (mirrors chromium's `results/`). It is
invisible to the input drain for free: `sendkeysWatcherDrain` already skips any
dir entry whose `kind != .file`, so a `responses/` subdirectory is never
scanned as an input. The dir is created lazily on first response write
(`makePath`), so the producer need not pre-create it. `GHOSTTY_SENDKEYS_RESP_DIR`
lets a caller point responses elsewhere (e.g. a tmpfs) without moving the spool.

### D4 — Atomic response writes (temp + rename), same discipline as the input side

Write to `<resp_dir>/.<id>.tmp`, then `rename(2)` to `<resp_dir>/<id>.response.json`.
`rename` is atomic on POSIX, so the producer polling for `<id>.response.json`
never observes a half-written file — the exact invariant the input spool relies
on, applied in reverse.

### D5 — `WAITFOR` blocks the watcher thread (sequential by design)

`WAITFOR` loops on the watcher thread, snapshotting every ~50ms, until the needle
appears / output settles / timeout. While it blocks, no other spool files drain.
This is intentional: a driver issues request→response sequentially (it waits for
`<id>.response.json` before sending the next request), so head-of-line blocking
is the correct semantics, not a bug. Injection is unaffected — it flows through
the mailbox to the main thread independently, and terminal output flows from the
IO thread, so the surface *does* change while `WAITFOR` polls it. Settle logic:
if `settle_ms > 0` and two consecutive snapshots `settle_ms` apart are byte-equal
(output quiet), return with `reason:"settled"`; needle match returns
`reason:"contains"`; deadline returns `reason:"timeout"`. `matched` always
reflects whether the needle is present in the final snapshot.

### D7 — Making PROMPT actually SUBMIT in a TUI: text→Enter delay + clean env

The whole point is driving a real Claude session, and a naive `PROMPT` (type +
immediate Enter) does NOT submit inside Claude Code, though it works in a plain
shell. Two independent root causes, each fixed:

1. **Paste-burst swallows the Enter.** Text is injected as one unpaced burst;
   Claude Code (Ink) treats a fast chunk as a paste, and a `\r` inside a paste is
   a literal newline, not a submit. Fix: `PROMPT` injects the text, sleeps
   `GHOSTTY_SENDKEYS_ENTER_DELAY_MS` (default 250ms) on the watcher thread — long
   enough for the paste to commit and for the Enter to land as a distinct, later
   keypress — then injects Enter. A standalone `KEY:enter` (dialog/menu accept)
   is unaffected: it has no preceding text burst. Alternatives considered:
   pacing every keystroke (slower, and unnecessary — only the Enter needs
   separation); sending `\n` vs `\r` (a shell proves `\r` is the correct submit
   byte, so the byte isn't the problem — the coalescing is).
2. **The operator's shell stack misroutes input.** The login shell auto-attaches
   tmux (+direnv), so `ghostty → zsh → tmux → claude` misroutes injected input to
   zsh (observed `zsh: no matches found: 21?`) and flaps the active screen. Fix
   (in `prove-twoway.sh`, not core): drive Claude as ghostty's own PTY process via
   `--command="/bin/bash --noprofile --norc -c 'cd <empty> && exec claude …'"` — no
   login shell, no tmux, Claude is the foreground PTY leader. This is a launch
   recipe, not a protocol change, but it is essential to the reliable
   visible-spawn primitive and is documented in the spec + skill.

### D6 — JSON via `std.json.Stringify` (safe escaping of surface text)

Surface text contains quotes, newlines, and control bytes; hand-rolling JSON
escaping is a bug farm. Responses are built with `std.json.Stringify` (already
used in `src/terminal/c/types.zig`), which escapes strings correctly.

## Risks / Trade-offs

- **[Watcher thread reads terminal while IO thread writes it]** → Mitigated by
  taking `renderer_state.mutex` for the snapshot, the same lock the renderer and
  IO threads use. Snapshot copies out to an owned buffer before unlocking.
- **[`WAITFOR` head-of-line blocks the drain loop]** → Accepted; sequential
  request/response is the intended usage. A pathological producer that pushes a
  long `WAITFOR` then unrelated fire-and-forget files will see them delayed;
  documented.
- **[Ack means "queued to mailbox", not "rendered"]** → The delivery ack for
  `TEXT`/`KEY`/`PROMPT` fires after the event is pushed to the surface mailbox,
  which is async. Confirming the *effect* is exactly what `WAITFOR` is for; the
  ack only proves the request was accepted. Documented.
- **[Orphaned response files]** → No GC; a producer that never reads its response
  leaves the file. Same limitation the sibling forks accept.
- **[`plainString` is viewport-only]** → Scrollback beyond the visible screen is
  not returned. Sufficient for driving prompts/dialogs; documented as a
  non-goal.
