# Two-way sendkeys — build report (2026-07-14)

Made the Ghostty fork's sendkeys channel **bidirectional**: a request→response
protocol with a `waitfor` primitive, so an external driver is no longer blind —
it can read the surface, wait on observed state, and reliably drive a real
`claude` session end-to-end. Spec-first, then implemented, then proven.

Branch: `twoway`. Owner acceptance: re-run `scripts/prove-twoway.sh`.

## 1. Spec first (before code)

- **`SENDKEYS_SPEC.md` → v2**: added the two-way protocol (the `@<id>` prefix,
  responses dir, `READ`/`READ:all`/`WAITFOR`/`PROMPT`/`screenshot`), the
  thread-safe snapshot design, and a full write-up of **The Enter bug** + the
  clean-environment launch recipe.
- **OpenSpec change `openspec/changes/two-way-sendkeys/`** (proposal + design +
  spec delta + tasks), `openspec validate` → **valid**. Capability:
  `sendkeys-two-way`. Design decisions D1–D7 (reads on the watcher thread under
  `renderer_state.mutex`; `@<id>` vs embedded id; responses dir; atomic writes;
  blocking `waitfor`; JSON via `std.json.Stringify`; and D7 = the Enter-bug fix).
- Modeled on the sibling forks read first: chromium's `results/` + `WAITFOR`
  and vscode's `@<id>` result channel — adapted to a terminal whose readable
  state is the screen buffer, not a DOM.

## 2. Implementation

- **Zig (`src/Surface.zig`)** — the watcher now:
  - parses an optional `@<id> ` prefix and writes `<id>.response.json`
    (atomic temp+rename) into `GHOSTTY_SENDKEYS_RESP_DIR` (default
    `<spool>/responses`, created lazily, invisible to the input drain);
  - `sendkeysSnapshot(alloc, full)` reads the screen (`.viewport` or `.screen`)
    **under `renderer_state.mutex`** — the same lock the IO/render threads take,
    so a watcher-thread read never races them (reads don't need the mailbox; only
    injection does, because it mutates apprt state);
  - handles `READ`/`READ:all`, `WAITFOR:<timeout>|<settle>|<needle>` (poll loop:
    contains / settled / timeout), and `PROMPT` (text → delay → Enter);
  - responses are built with `std.json.Stringify` (correct escaping of surface
    text).
- **CLI (`sendkeys.js`)** — `read [--lines N|--all]`, `gettext --all`,
  `waitfor --contains … [--timeout-ms N] [--settle-ms N]`, `prompt`, `--wait`
  acks on v1 verbs, id generation + response polling, and macOS `screenshot`.
- **Tests (`sendkeys.test.js`, headless)** — 8 tests, all green: request-line
  encoding (id prefix, waitfor payload with `|` in the needle, bare→TEXT),
  responses-dir resolution, atomic push, and `pollResponse` read/delete +
  timeout deadline.
- **Build**: `zig build` (pinned zig 0.15.2) — full macOS app rebuilt clean.

## 3. The Enter bug (owner addendum B) — root-caused and fixed

**Symptom:** `KEY:enter` submits fine in a plain shell, but with `claude`
running the injected prompt text landed in Claude's input box and just *sat*
there — Enter never submitted. Reproduced on the first `prove-twoway.sh` run.

Two independent root causes, both fixed:

1. **Paste-burst swallows the Enter.** Text is injected as one unpaced burst;
   Claude Code (Ink) treats a fast chunk as a *paste* and inserts a trailing
   `\r` as a literal newline instead of submitting. A shell has no such
   heuristic — hence v1 "worked" on a shell only. **Fix:** `PROMPT` injects the
   text, sleeps `GHOSTTY_SENDKEYS_ENTER_DELAY_MS` (default **250ms**), then
   injects Enter as a distinct, later keypress → the TUI submits.
2. **The operator's shell stack misroutes input.** The login shell auto-attaches
   **tmux** (+direnv), so `ghostty→zsh→tmux→claude` routed injected input to
   zsh (observed live: `zsh: no matches found: 21?` from the prompt text hitting
   the shell) and flapped the active screen. **Fix:** drive Claude as ghostty's
   own PTY process in a clean env —
   `--command="/bin/bash --noprofile --norc -c 'cd <empty> && exec claude …'"`.

Evidence trail of the diagnosis is in `twoway-notes/` (owner's addendum +
captured runs); the fixes land in `src/Surface.zig` (delay) and
`scripts/prove-twoway.sh` (clean-env launch).

## 4. Acceptance (owner addendum C) — PASS

`scripts/prove-twoway.sh` launches `claude --dangerously-skip-permissions` in a
clean dir, accepts the trust dialog with `KEY:enter`, waits for boot, then
`prompt "What is 21 plus 21? Reply with only the number and nothing else."` and
`waitfor --contains "42"`. `42` is **not** in the prompt, so a match can only be
Claude's own output — proof that Enter submitted in the TUI. Full run output:
`twoway-notes/prove-twoway-output.txt`; window PNG:
`twoway-notes/prove-twoway-result.png`. Key lines:

```
--- [1] wait for the trust dialog (if any) ---
>>> trust dialog present -> KEY:enter to accept

--- [2] wait for claude boot (bypass permissions banner) ---
boot matched=true reason=contains elapsed_ms=486

--- [3] PROMPT the model (answer '42' is NOT in the prompt) ---

--- [4] WAITFOR the model's answer '42' (acceptance) ---
waitfor matched=true reason=contains elapsed_ms=1841
--- surface tail ---
⏺ 42

PROVE-TWOWAY: PASS  (drove a claude session end-to-end; Enter submitted in the TUI)
```

The mechanism is deterministic (Enter submits, input routes to Claude, waitfor
observes the answer in ~1.8s). Any residual timing variance is Claude's own
response latency, not the transport — the clean empty working dir keeps that
fast and repeatable.

## 5. Owner addendum A — extra read verbs

- **`gettext --all` / `READ:all`** → full scrollback (`.screen`), not just the
  visible viewport. (A TUI on the alternate screen — like Claude — has no
  scrollback, so it ≈ `read` there; matters for shell sessions.)
- **`screenshot <path> [--pid N]`** → PNG of the ghostty window via macOS
  `screencapture`, window resolved by owner PID (JXA `CGWindowListCopyWindowInfo`),
  full-screen fallback otherwise. **Caveat:** macOS Sonoma+ requires **Screen
  Recording permission** for the invoking terminal to enumerate/capture other
  apps' windows; without it, window resolution returns nothing (falls back to
  full-screen) and pixels may be blank. For a terminal the authoritative visual
  state is the text (`read`/`gettext`); the PNG is a convenience.

## 6. Files

| File | Change |
|---|---|
| `SENDKEYS_SPEC.md` | v2 two-way protocol + Enter-bug write-up |
| `openspec/changes/two-way-sendkeys/` | OpenSpec change (proposal/design/spec/tasks), validated |
| `src/Surface.zig` | `@<id>` parse, responses dir, `sendkeysSnapshot`, READ/WAITFOR/PROMPT, atomic response writes, enter-delay |
| `sendkeys.js` | `read`/`gettext`/`waitfor`/`prompt`/`screenshot`, `--wait`, id + response polling |
| `sendkeys.test.js` | headless CLI request/response + timeout tests (8, green) |
| `scripts/prove-twoway.sh` | end-to-end proof (clean-env claude, trust→boot→prompt→waitfor 42) |
| `.claude/skills/ghostty-sendkeys/SKILL.md` | two-way verbs + the two claude-driving gotchas |
| `twoway-notes/prove-twoway-output.txt`, `…-result.png` | acceptance run output + window PNG |

## 7. Known limitations

- `waitfor` blocks the watcher (sequential request/response by design).
- `screenshot` needs macOS Screen Recording permission (see A above).
- No response-file GC; the producer deletes each after reading.
- Single active surface; not wired into CI (manual/agent driver, like v1).
