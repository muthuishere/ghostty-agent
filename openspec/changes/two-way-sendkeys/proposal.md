## Why

The existing sendkeys spike is **write-only**: an external driver can inject
`TEXT:`/`KEY:` events into a running Ghostty surface but has no way to observe
the result. A driver is therefore blind — it cannot tell a "trust this folder"
dialog from a ready prompt from a finished answer, so it must guess with fixed
sleeps. To reliably drive an interactive program (e.g. a `claude` session)
end-to-end, the channel must become **bidirectional**: a request→response
protocol plus a `waitfor` primitive that blocks on observed terminal state.

## What Changes

- Add a **response channel**: any request line may carry an `@<id>` prefix; the
  watcher writes an atomic `<id>.response.json` into a responses directory
  (default `<spool>/responses/`, overridable by `GHOSTTY_SENDKEYS_RESP_DIR`).
- Add verb **`READ`** / **`READ:<lines>`** → snapshot the visible surface text
  (viewport) and return it in the response.
- Add verb **`WAITFOR:<timeout_ms>|<settle_ms>|<needle>`** → block until the
  surface contains `<needle>`, or output goes quiet for `settle_ms`, or
  `timeout_ms` elapses; return `{matched, reason, elapsed_ms, surface}`.
- Add verb **`PROMPT:<text>`** → type text, pause, then Enter as one atomic
  request; returns a delivery ack. The pause (`GHOSTTY_SENDKEYS_ENTER_DELAY_MS`,
  default 250ms) is the fix for **the Enter bug**: without it a TUI (Claude Code)
  swallows the trailing Enter as paste content and the line never submits.
- Add **`READ:all`** / **`gettext --all`** → full scrollback (`.screen`), not
  just the visible viewport.
- Add producer-side **`screenshot <path> [--pid N]`** → PNG of the ghostty window
  (macOS; needs Screen Recording permission, falls back to full-screen).
- Document the **clean-environment launch recipe** (`--command=… exec claude`)
  needed so injected input reaches Claude instead of the operator's tmux/zsh.
- Existing `TEXT:`/`KEY:`/bare lines stay **fully back-compatible** (one-way,
  fire-and-forget) but MAY now carry an `@<id>` to get a delivery ack.
- Extend the `sendkeys.js` producer CLI with `read`, `waitfor`, `prompt`, an
  `--id`/`--wait` flag, and response polling.
- Add `scripts/prove-twoway.sh` that drives a real `claude` session end-to-end.

## Capabilities

### New Capabilities
- `sendkeys-two-way`: the bidirectional request→response protocol for the
  sendkeys spool — response correlation by id, surface reads, and the `waitfor`
  primitive — layered on top of the existing one-way key-injection spool.

### Modified Capabilities
<!-- The original one-way sendkeys feature was a spike and never captured as an
     OpenSpec spec, so there is no prior spec whose requirements change. The
     two-way protocol is additive and back-compatible; it is captured entirely
     as the new capability above. -->

## Impact

- `src/Surface.zig` — watcher gains READ/WAITFOR/PROMPT handling, safe surface
  snapshotting under `renderer_state.mutex`, and atomic response-file writes.
- `src/apprt/surface.zig` — unchanged wire union (`inject_key` already covers
  injection; reads happen directly on the watcher thread, not via the mailbox).
- `sendkeys.js` — new subcommands + response polling.
- `scripts/prove-twoway.sh`, `SENDKEYS_SPEC.md`,
  `.claude/skills/ghostty-sendkeys/SKILL.md` — docs + proof harness.
- No change to upstream Ghostty behavior; fork-local automation feature only.
