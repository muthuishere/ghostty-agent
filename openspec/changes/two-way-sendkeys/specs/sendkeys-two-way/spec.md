## ADDED Requirements

### Requirement: Request identity and response correlation

Any spool request line MAY begin with an `@<id> ` prefix (an id matching
`[A-Za-z0-9._-]+` followed by exactly one space). When present, the watcher MUST
write exactly one response file for that request into the responses directory,
named `<id>.response.json`, after the request line is handled. Requests without
an `@<id>` prefix remain fire-and-forget and produce no response.

The responses directory defaults to `<spool>/responses/` and is overridden by
the `GHOSTTY_SENDKEYS_RESP_DIR` environment variable when set. The watcher MUST
create the responses directory lazily on first write; the producer is not
required to pre-create it. The responses directory MUST NOT be scanned as an
input source.

#### Scenario: Response written for an identified request
- **WHEN** a spool file contains `@abc123 READ`
- **THEN** the watcher writes `<resp_dir>/abc123.response.json` containing an
  object with `"id":"abc123"` and `"ok":true`

#### Scenario: No response for an unidentified request
- **WHEN** a spool file contains `READ` with no `@<id>` prefix
- **THEN** the watcher performs the read but writes no response file

#### Scenario: Response directory override
- **WHEN** `GHOSTTY_SENDKEYS_RESP_DIR` is set to an existing directory `R`
- **THEN** response files are written under `R`, not under `<spool>/responses/`

### Requirement: Atomic response writes

The watcher MUST publish each response file atomically: write the JSON to a
staging path (a dotfile, e.g. `<resp_dir>/.<id>.tmp`) and `rename(2)` it to
`<resp_dir>/<id>.response.json`. A producer polling for `<id>.response.json` MUST
never observe a partially written file.

#### Scenario: Producer never sees a torn response
- **WHEN** the watcher is mid-write of a large surface snapshot
- **THEN** `<id>.response.json` does not exist until the complete JSON is in place

### Requirement: Delivery acknowledgement for injection verbs

The one-way verbs `TEXT:`, `KEY:`, and the new `PROMPT:` verb, when carrying an
`@<id>` prefix, MUST return a delivery-acknowledgement response of the form
`{"id":..., "ok":true, "verb":..., "delivered":true}` once the synthetic events
have been queued to the surface mailbox. The ack signifies acceptance/queueing,
not that the effect has rendered.

#### Scenario: type with id returns an ack
- **WHEN** a spool file contains `@k1 TEXT:hello`
- **THEN** `k1.response.json` contains `{"id":"k1","ok":true,"verb":"text","delivered":true}`

### Requirement: PROMPT verb types text and Enter atomically, and SUBMITS in a TUI

A `PROMPT:<text>` line MUST inject `<text>`, then pause for a configurable delay
(`GHOSTTY_SENDKEYS_ENTER_DELAY_MS`, default 250ms), then inject a single Enter
key press as one request, so a driver can submit a command in one request. The
pause is required so a TUI (e.g. Claude Code) that treats a fast text burst as a
paste sees the trailing Enter as a distinct keypress and SUBMITS the line rather
than inserting a literal newline into the input.

#### Scenario: prompt submits a command in a shell
- **WHEN** a spool file contains `PROMPT:echo hi`
- **THEN** the surface receives the characters `echo hi` and then an Enter press

#### Scenario: prompt submits inside an Ink/Claude-Code TUI
- **WHEN** a Claude Code session is active and a spool file contains
  `PROMPT:What is 21 plus 21? Reply with only the number and nothing else.`
- **THEN** the line is SUBMITTED (not left sitting in the input box) and the
  model's answer (`42`) appears on the surface

### Requirement: READ:all returns the full scrollback

A `READ:all` line MUST snapshot the entire written screen (scrollback +
viewport, the `.screen` region) rather than just the visible viewport, and
return it in the read response.

#### Scenario: full scrollback read
- **WHEN** a shell has scrolled output beyond the visible rows and a spool file
  contains `@g1 READ:all`
- **THEN** `g1.response.json`'s `surface` includes rows above the current viewport

### Requirement: Screenshot capture (producer-side)

The producer CLI MUST provide a `screenshot <path> [--pid <ghostty pid>]`
command that captures a PNG of the ghostty window (macOS), resolving the window
by owner PID and falling back to a full-screen capture when the window cannot be
resolved. This is a local capture and does not use the spool/response channel.

#### Scenario: screenshot writes a PNG
- **WHEN** `screenshot out.png --pid <pid>` is run against a live ghostty
- **THEN** a PNG file is written at `out.png` (window-scoped if resolvable, else
  full-screen)

### Requirement: READ returns the visible surface text

A `READ` line (optionally `READ:<lines>`) MUST snapshot the active surface's
visible viewport as plain UTF-8 text and, when identified, return it in the
response as `{"id":..., "ok":true, "verb":"read", "surface":"<text>", "lines":N}`.
When `<lines>` is given, only the last `<lines>` lines of the snapshot are
returned. The snapshot MUST be taken while holding the surface's
`renderer_state.mutex` so it never races the render/IO thread.

#### Scenario: read returns current screen text
- **WHEN** the shell in the surface has printed `READY` and a spool file contains
  `@r1 READ`
- **THEN** `r1.response.json`'s `surface` field contains `READY`

#### Scenario: read with a line limit
- **WHEN** a spool file contains `@r2 READ:5`
- **THEN** the `surface` field contains at most the last 5 lines of the viewport

### Requirement: WAITFOR blocks until a condition or timeout

A `WAITFOR:<timeout_ms>|<settle_ms>|<needle>` line MUST repeatedly snapshot the
surface until one of: the surface contains `<needle>` (`reason:"contains"`),
output goes quiet for `settle_ms` when `settle_ms > 0` (`reason:"settled"`), or
`timeout_ms` elapses (`reason:"timeout"`). It MUST return
`{"id":..., "ok":true, "verb":"waitfor", "matched":<bool>, "reason":..., "elapsed_ms":N, "surface":"<text>"}`
where `matched` reflects whether `<needle>` is present in the final snapshot.
An empty `timeout_ms` defaults to 30000; an empty `settle_ms` defaults to 0
(disabled). `<needle>` is the entire remainder of the line after the second `|`,
so it may itself contain `|`.

#### Scenario: waitfor matches
- **WHEN** the surface will print `READY` within 2s and a spool file contains
  `@w1 WAITFOR:60000|0|READY`
- **THEN** `w1.response.json` has `"matched":true` and `"reason":"contains"`

#### Scenario: waitfor times out
- **WHEN** the needle never appears and a spool file contains
  `@w2 WAITFOR:500|0|NEVER`
- **THEN** `w2.response.json` has `"matched":false` and `"reason":"timeout"`

#### Scenario: waitfor settles on quiet output
- **WHEN** output stops changing and a spool file contains
  `@w3 WAITFOR:60000|300|NEVER`
- **THEN** `w3.response.json` has `"reason":"settled"` and `"matched":false`

### Requirement: Back-compatibility of one-way verbs

Existing `TEXT:`, `KEY:`, and bare (prefix-less) lines without an `@<id>` prefix
MUST behave exactly as in the one-way protocol: injected as synthetic key events,
fire-and-forget, no response written. Adding two-way verbs MUST NOT change their
behavior.

#### Scenario: legacy line unchanged
- **WHEN** a spool file contains `TEXT:echo hi` then `KEY:enter` with no ids
- **THEN** the characters and Enter are injected and no response files are written
