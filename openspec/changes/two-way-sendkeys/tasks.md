## 1. Spec

- [ ] 1.1 Write `SENDKEYS_SPEC.md` v2 (two-way protocol: `@<id>`, responses dir, READ/WAITFOR/PROMPT, snapshot safety)
- [ ] 1.2 Author this OpenSpec change (proposal, design, spec delta, tasks)

## 2. Zig implementation (`src/Surface.zig`)

- [ ] 2.1 Resolve responses dir (`GHOSTTY_SENDKEYS_RESP_DIR` or `<spool>/responses`) at watcher start; store + free on thread exit
- [ ] 2.2 Parse optional `@<id> ` prefix in `sendkeysProcessLine`; thread `id` through dispatch
- [ ] 2.3 `sendkeysSnapshot(alloc)` — lock `renderer_state.mutex`, `terminal.plainString`, trim trailing blank lines, owned buffer
- [ ] 2.4 `READ` / `READ:<lines>` handler → build read response
- [ ] 2.5 `WAITFOR:<timeout_ms>|<settle_ms>|<needle>` handler — poll loop (contains/settle/timeout), build waitfor response
- [ ] 2.6 `PROMPT:<text>` handler — inject text + Enter; delivery ack
- [ ] 2.7 Delivery ack for identified `TEXT`/`KEY`
- [ ] 2.8 `sendkeysWriteResponse(id, json)` — build JSON via `std.json.Stringify`, atomic temp+rename, lazy `makePath`

## 3. Producer CLI (`sendkeys.js`)

- [ ] 3.1 Add `--id`/auto-id, `--resp-dir` (default `<dir>/responses`), response polling helper
- [ ] 3.2 `read [--lines N]` subcommand (id + poll + print)
- [ ] 3.3 `waitfor --contains <t> [--timeout-ms N] [--settle-ms N]` subcommand
- [ ] 3.4 `prompt <text>` subcommand
- [ ] 3.5 `--id`/`--wait` on existing `type`/`key`/`send` for acks

## 4. Tests (headless, no app)

- [ ] 4.1 CLI request-line encode: id prefix, waitfor payload, prompt line
- [ ] 4.2 CLI response decode + waitfor timeout logic (poll deadline)

## 5. Build + prove

- [ ] 5.1 `zig build` the fork (pinned zig 0.15.2)
- [ ] 5.2 `scripts/prove-twoway.sh` — launch → waitfor trust dialog → accept → prompt READY → waitfor READY → assert
- [ ] 5.3 Capture run output into `REPORT.md`

## 6. Docs + delivery

- [ ] 6.1 Update `.claude/skills/ghostty-sendkeys/SKILL.md` with two-way verbs
- [ ] 6.2 Commit on `twoway`, push, open PR for owner review
