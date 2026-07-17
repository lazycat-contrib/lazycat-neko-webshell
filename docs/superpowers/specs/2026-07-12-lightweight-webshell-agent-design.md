# Lightweight WebShell Agent Design

> Sequenced after `2026-07-12-official-lightos-webshell-contract-design.md`.
> Device evidence showed that the official account-scoped instance/selector
> contract had to be repaired first. That dependency is now satisfied; this
> design covers the second independent reliability layer.

## Context

Native WebShell workspaces are owned by an agent inside the selected LightOS target. The provider currently installs that agent by copying `std::env::current_exe()` into the target. The released `v0.5.19` provider executable is 80,122,128 bytes, so a missing or unusable agent makes the initial workspace request synchronously transfer roughly 80 MB through `lightosctl exec -i`.

The frontend waits for that workspace request before refreshing the available session backends and Herdr state. One failed agent bootstrap therefore presents as three failures: native shells cannot be created, the Herdr backend option disappears, and existing Herdr workspaces are not shown. `v0.5.21` only avoids the transfer when an installed agent still exists and restarts successfully.

## Goals

- Preserve the persistent target-local workspace model for native WebShell sessions.
- Install a dedicated lightweight agent binary instead of the full provider executable.
- Keep all `v0.5.20` frontend, mobile-input, and option fixes.
- Let optional backend state, especially Herdr, load when the native agent is unavailable.
- Add release and test gates that prevent the provider executable from becoming the agent payload again.

## Non-goals

- Replacing the persistent agent with the older provider-owned PTY model.
- Changing Herdr protocol behavior, terminal rendering, mobile input, or plugin behavior.
- Broadly refactoring `main.ts`; any frontend edit must remain workspace-startup orchestration only.

## Considered Approaches

### A. Dedicated lightweight agent plus graceful workspace degradation

Build a second Rust binary containing only the agent daemon, protocol, PTY, workspace, configuration, and validation modules. Embed its bytes into the provider at release build time and copy only that payload into target instances. If native-agent startup still fails, return the provider-owned optional-backend workspace so Herdr discovery and existing Herdr entries remain usable.

This is the selected approach because it preserves durable native sessions while removing the oversized transfer from the critical path.

### B. Restore provider-owned direct PTYs

Route native WebShell sessions through the existing managed-terminal store. This avoids agent installation but loses target-local durability across provider restarts and changes the current session contract.

### C. Increase transfer timeouts and retries

Continue copying the full provider executable with a longer timeout. This leaves an 80 MB synchronous bootstrap in place and does not remove the coupling that hides Herdr.

## Architecture

### Embedded agent payload

The build produces two Rust binaries internally:

- `lazycat-neko-webshell`: HTTP/WebSocket provider with embedded frontend and all integrations.
- `lazycat-neko-webshell-agent`: target-local agent with no HTTP server, frontend, AI, SSH management, plugin, or asset modules.

The release build embeds the lightweight agent bytes into `lazycat-neko-webshell`, so the LPK content still ships one executable and requires no runtime download or additional manifest field. The internal agent build keeps the existing `agent version`, `agent daemon`, `agent request`, and `agent attach` command contract.

### Agent installation

`agent_client` reads the compile-time embedded agent payload. SHA-256 identifies the exact bytes and their content-addressed target path; it does not force replacement by itself. `/usr/local/bin/lazycat-neko-webshell-agent` remains a stable symlink to the active lightweight payload.

The wire protocol remains at `v4` because the extraction does not change any protobuf message or command behavior. Agent reuse checks the protocol first and the agent implementation version second. `AGENT_VERSION` advances when target-local agent code or dependencies change, while `MIN_SUPPORTED_AGENT_VERSION` advances only when the provider must replace older agents. An older protocol is upgraded regardless of its numeric agent version; a newer protocol is never downgraded by an older provider. Application versions, provider commits, frontend work, and packaging changes do not change either value by default, so a compatible running agent remains reusable even when the provider embeds a different SHA. The published `v0.5.35` content-addressed agent maps to agent version `1`; the `v0.5.36` embedded agent reports version `2` while keeping the minimum supported version at `1`. A `v0.5.34` agent has neither payload identity nor an agent version and therefore receives one migration to the content-addressed v2 agent.

The transfer helper applies one timeout to the complete spawn/write/wait operation so a blocked stdin write cannot hang workspace loading indefinitely.

### Workspace degradation

Loading a LightOS workspace still prefers the persistent native agent. If agent bootstrap or state retrieval fails, the workspace endpoint logs the native-agent failure and returns the provider-owned optional-backend snapshot instead of returning an empty UI error. This snapshot includes existing Herdr/zellij tabs and allows the frontend's normal backend and Herdr refresh calls to run.

Native create/update actions continue to report agent errors; they must not silently create a second provider-owned native session model. Herdr and zellij actions continue through their existing provider-owned workspace path.

## Data Flow

1. The browser requests the selected workspace.
2. The provider authorizes the selector and pings an existing compatible agent.
3. If needed, the provider installs the embedded lightweight `v4` agent and starts it.
4. On success, native agent state is merged with optional backend tabs.
5. On native-agent failure, optional backend tabs are returned and the failure is logged.
6. The browser applies the returned workspace, then refreshes backend availability and Herdr state as it does today.

## Error Handling

- Missing or invalid embedded agent payload: fail with a specific provider build error; never fall back to `current_exe()`.
- Target transfer timeout: terminate the child process and return a bounded error.
- Agent start/protocol failure: preserve current diagnostics and log tail.
- Workspace load failure: retain optional backends in the response and log the native-agent error.
- Native action failure: show the existing connect error; do not create duplicate sessions.

## Verification

- Unit test that agent installation uses the embedded payload and cannot resolve to the provider executable.
- Unit test that agent failure workspace degradation preserves optional backend tabs.
- Agent CLI smoke test: the internal agent build prints the expected protocol version before it is embedded.
- Agent compatibility smoke test: the internal agent build reports a positive agent version and a positive minimum supported version no greater than the embedded agent version.
- Release build gate: the internal agent binary exists before provider compilation, is embedded into the provider, stays below an explicit size ceiling, and is materially smaller than the provider.
- Existing frontend tests, typecheck/build, Rust tests, Clippy, LPK lint, and `git diff --check` pass.
- Inspect the built LPK and verify it contains the single provider executable with the embedded agent metadata/version smoke check succeeding.
- Device acceptance: on a target without an installed agent, native shell creation completes; if the native agent is deliberately unavailable, Herdr remains listed and its existing workspaces remain visible.

## Release

After verification, bump the patch version, commit the implementation, push `main`, create an annotated tag, and verify the published LPK and CI/store results. Real-device acceptance remains a separate final check because local tests cannot execute the user's LightOS target path.
