# Session Manager, Launch, Mobile Keyboard, And Image Paste Design

## Goal

Refactor session management around one lifecycle owner while preserving the existing frontend/API contracts, then add compatible launcher resolution and mobile-only Termux-style extra keys.

## Constraints

- Keep protobuf field numbers and existing `/api/workspace`, `/ws/terminal`, and Connect contracts stable.
- Preserve stable `tab.id`, `pane.id`, and `session_id` across refresh and restart.
- Preserve output history and replay semantics keyed by `session_id`.
- Preserve selector authorization with exact `<name>@<owner_deploy_id>` values.

## Backend Session Design

The current code spreads session lifecycle across `state.rs`, `workspace.rs`, `terminal.rs`, and `service.rs`. The new `session_manager` module becomes the owner for session record mutation, PTY open/close coordination, output buffer lookup/removal, and session persistence.

`WorkspaceRecord` remains the owner of durable UI topology: selectors, tabs, panes, active IDs, and layouts. It should create and close pane/session references, but it should not decide live PTY status. Newly created workspace sessions start as `starting`; the session manager marks them `running` only after PTY open succeeds, marks them `stopped` if spawning fails, and marks them `exited` on process exit.

Resize, restart policy, output buffer policy, and control leases are persisted through session manager methods so every mutation follows the same clone-under-lock, persist-after-lock pattern.

## Launch Resolution

The frontend keeps `?name=` as the canonical shareable selector. Launch resolution becomes:

1. Explicit `?name=` wins if it is visible and running.
2. Without `?name=`, reuse the last valid selector if it is still running.
3. Otherwise use the first running instance.

All resolved launches load `/api/workspace`; direct `/ws/terminal?name=` remains compatibility-only.

## Deferred Image Paste

Herdr does not provide a direct OS image clipboard paste path. WebShell should implement image paste as a safe upload:

- Browser reads image from paste event or clipboard API.
- Frontend validates MIME and size before upload.
- Backend validates selector authorization, MIME, size, extension, and magic bytes.
- Backend writes to `/tmp/lazycat-webshell-paste/<random>.<ext>` inside the target instance using `lightosctl exec`.
- Frontend pastes a shell-quoted path into the active terminal.

Kitty graphics escape sequences must not be injected into PTY input.

This work is deferred and is not part of the current implementation.

## Mobile Keyboard

Replace the single mobile shortcut row with a mobile-only extra-key pad modeled after Termux:

- Primary keys: `Esc`, `Tab`, sticky `Ctrl`, `Alt`, `Shift`, `-`, `/`, arrows, `Enter`, paste.
- Navigation keys: `Home`, `End`, `PgUp`, `PgDn`, `Ins`, `Del`, `Bksp`.
- Symbol keys: `|`, `~`, `_`, quotes, backtick, backslash.
- Function keys: `F1` through `F12`.

Only show the pad on touch/mobile devices, not merely narrow desktop windows. Use the existing `keyboard.ts` encoder and Restty `sendKeyInput` path.

## Verification

- `npm run build`
- `cargo test`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `lzc-cli project release`
