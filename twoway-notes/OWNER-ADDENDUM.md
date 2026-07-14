# OWNER ADDENDUM to the two-way mission (2026-07-14)

## A. ADD two more read verbs (owner)
- `screenshot <path>` → write a PNG of the surface/window. (macOS: capture the ghostty
  window via screencapture -l <windowid>, or the render surface if reachable from Zig —
  spec whichever is reliable; a window-level PNG is acceptable if surface-capture is hard.)
- `gettext --all` (or `read --all`) → return the FULL scrollback text, not just visible rows.
Both go in the spec + CLI + skill, same request→response channel as read/waitfor.

## B. THE REAL BUG to fix (evidence: docs-enter-bug.png) — Enter does NOT submit in the
Claude Code TUI. KEY:enter submits fine in a plain SHELL (proven: echo>file ran), but with
`claude` running, the injected prompt text lands in Claude's input box and just SITS there —
Enter is NOT submitting it. Root-cause it (candidates: TEXT: uses bracketed-paste so the
trailing Enter is swallowed as newline inside the paste; or Claude's Ink/TUI needs \r vs \n;
or the enter races before the pasted text is committed; or the TUI needs a distinct keypress
event not a pasted CR). Fix so that after `prompt "..."` the line ACTUALLY SUBMITS in the
Claude Code TUI.

## C. ACCEPTANCE TEST (must pass, this exact case):
prove-twoway.sh drives `claude --dangerously-skip-permissions`, sends
`prompt "What is 21 plus 21? Reply with only the number and nothing else."`, then
`waitfor --contains "42" --timeout-ms 60000` → MUST match (i.e. Claude actually received AND
answered, proving Enter submitted in the TUI). Screenshot the result into the report.
This is the whole point: the organ must reliably drive a real Claude session, not just a shell.
