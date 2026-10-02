# Agent update experience

Implement in the pending 0.8.8 release alongside the settings and tools improvements.

- Inspect the selected authorized LightOS target without starting an agent or creating a PTY. Compare protocol first, then minimum agent version. A newer protocol is never downgraded.
- Required compatibility updates run automatically under the existing selector and target locks. Revalidate the readable incompatible running identity immediately before restart and preserve newer installed payloads. They do not ask for a decision. Inspection, network or installation failures show a retry action; unknown status never starts an automatic replacement.
- A compatible older agent is reused. Show an optional, non-blocking update entry and a persistent settings panel. “Later” suppresses that version's entry for the current browser session; settings remains available.
- Optional updates prepare the content-addressed payload and stable launch symlink. They never stop the running agent, prune its payload, or restart a PTY. The UI explicitly says the prepared update takes effect after the instance next restarts.
- Serialize preparation with the existing local selector and target locks. Recheck protocol, agent version, and running payload identity after taking the locks. Do not overwrite a newer installed protocol.
- Keep Herdr independent. Reuse compatible servers and keep active jobs running. Required Herdr migration continues through the existing confirmed live-handoff guard; do not fall back to killing/restarting its server.
- Bind frontend state and actions to selector plus selection generation. A stale response must not update another target's UI.
- Put backend upgrade logic in an agent-client submodule and HTTP handlers in a focused module. Frontend API, state, view, and settings markup live in agent-updates. Keep main.ts to composition.

Verification: backend policy/identity tests; UI controller tests for required, optional, newer, deferred, error and target-switch paths; a browser scenario exercising optional preparation and mandatory automatic update; full build and release checks before commit/tag/publish.
