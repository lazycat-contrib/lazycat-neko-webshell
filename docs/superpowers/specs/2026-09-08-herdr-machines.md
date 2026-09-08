# Herdr machine management

## Objective and acceptance

- Keep native Herdr machine/workspace navigation as the only persistent machine tree. Do not duplicate Local or workspace groups in WebShell.
- Herdr's More menu opens a machine manager for the selected LightOS target and login user.
- List saved machines, rename, enable/disable and remove them using the installed Herdr CLI. Confirm removal with machine identity and explain that remote sessions remain running.
- Add defaults to Host aliases from the target user's `~/.ssh/config`, with manual SSH target entry available. Pass aliases unchanged to OpenSSH. Never copy credentials into machine profiles.
- Offer an optional SSH connection test before adding. It uses OpenSSH `true`, supports authentication/host trust prompts, preserves form drafts, clears success on target edits and never installs Herdr or saves a machine.
- Add opens an interactive setup terminal in the manager for SSH authentication, host trust and Herdr installation approval. Refresh the machine list after successful completion. Closing setup cancels its process.
- Keep requests and setup sessions scoped to selector/generation; discard stale results and cancel setup on target changes.
- Probe CLI availability rather than infer machine commands from the running server's protocol. Keep the SockAPI allowlist unchanged.

## Structure and style

Use focused `src/herdr/machines.rs`, `src/agent_daemon/machines.rs` and `src/frontend/src/herdr-machines/` modules. `main.ts` only composes the controller and menu. Follow existing typed controllers, escaped templates, theme tokens and bilingual translation keys. Example: `request(target, { action: "rename", id, label })`.

## Boundaries

Always authorize target access; execute Herdr as the target login UID/GID with a controlled environment and bounded runtime/output. Use argv, never concatenate shell commands. Bump agent implementation version for the new CLI, with a feature-specific minimum; retain the global supported minimum. Never auto-approve SSH trust or Herdr installation, stop remote sessions on removal, expose unknown SockAPI methods. Release application version 0.8.0 and tag v0.8.0 after verification, as requested by the user.

## Implementation and verification

1. Implement validated CLI actions and bounded PTY setup, then authenticated provider HTTP/WebSocket routes.
2. Implement the machine manager, SSH Host picker and interactive setup terminal using existing visual conventions.
3. Test validation, malformed data, stale async results, mutation serialization and setup lifecycle. Verify the real rendered manager at desktop and 375px widths.

Commands: `cargo test --bin lazycat-neko-webshell herdr`, `cargo test --bin lazycat-neko-webshell-agent`, `npm run test:frontend`, `npm run build`, `git diff --check`.

SSH Host discovery initially reuses the existing target SSH config parser. Include expansion must remain bounded, run as the login user and never evaluate Match exec while discovering aliases.
