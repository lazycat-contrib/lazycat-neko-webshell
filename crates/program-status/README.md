# Program status adapter

This crate owns OSC 7501 parsing, support-probe replies, and the bounded status
table for one live PTY. It uses `w1 = "0.3"` internally; its public API and wire
records expose no w1 types. Replace the parser here when changing libraries.

`Tracker::observe` inspects live output without changing it. Send its returned
reply bytes to the PTY once, before broadcasting the original output. Never feed
replayed output into a live tracker. Attachments receive the current table after
replay, then replacements only when its revision changes. Clearing the root
clears the table; clearing an ID removes that ID and its descendants.

Native OSC 7501 applications and commands launched through `w1 codex` etc. work
with the same adapter. The automatic detector inspects the PTY's foreground
process group and at most 64 same-user, same-session, same-TTY descendants. It
uses w1 command recognition and screen rules without changing process-wide HOME
or cwd or reading another login user's session stores. Native reports take
precedence over inferred state. A readable replacement process clears stale
records; inspection errors retain the last identity. Linux process inspection
and w1 types are contained in this crate.

The optional `status-hook claude|codex` helper translates typed Agent hooks into
short OSC reports with the reserved `_neko_hook` ID. Native application reports
take precedence over these reports, which take precedence over screen inference.
Hook-backed blocked state returns to screen inference on actual user input, so
an approval cannot leave it stuck until the next hook. Ctrl+C and foreground
identity replacement clear hook state. The helper is off unless explicitly
enabled; setup and limits are in [the hook guide](../../docs/agent-status-hooks.md).
