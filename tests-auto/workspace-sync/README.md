# Workspace consistency in two browsers

Run `node tests-auto/workspace-sync/run.mjs`, or `npm run test:browser` for all required browser scenarios.

The scenario starts an isolated, freshly built Rust agent and real shell PTYs. A local test HTTP/WebSocket bridge exposes that agent to two independent Chrome sessions. The browser fixture imports the application's request controller, incremental reconciliation, pane lifetime and passive scheduler together with Restty 0.3.0. This covers the state and transport contracts without needing a LightOS deployment.

Requirements: Node with the repository npm dependencies installed, Rust/protoc as used by the normal build, `agent-browser` on PATH, Chrome, and a local TrueType monospace font. On Linux the default font is `/usr/share/fonts/liberation/LiberationMono-Regular.ttf`; set `WEBSHELL_TEST_FONT` for another path. `NEKO_BROWSER_AGENT_BINARY` can select an already-built compatible agent, otherwise the runner builds the repository's debug agent. Runtime sockets and shell working directories are isolated under a temporary directory. Test schemas, screenshots and JSON results stay in ignored `tests-auto/artifacts/`.

The checks cover:

- Hold the response of a real create-tab action, change local focus, then release it: creation remains visible and focus stays where the browser selected it.
- The second browser discovers the new pane, preserving the two existing terminal instances, connections and pending input.
- Peer rename and deletion converge without reconnecting unchanged panes; a removed runtime is disposed once.
- Pause and resume passive synchronization.
- Input travels through a real WebSocket and agent into a PTY; formatted shell output returns to the browser.

Failures retain screenshots, the isolated fixture state and an error summary. A required scenario failure is a nonzero exit, never a successful skip. Cleanup closes only the test-owned tabs, sockets, agent and named browser sessions.

Scope limits: this fixture bypasses the provider's LightOS authorization/routing and simplifies the outer application chrome. It does not certify remote LightOS or physical mobile-device behavior. The Rust suite separately covers provider frame cancellation, socket deadlines and protocol compatibility. Browser unit/controller tests remain in `src/frontend/src/` and run through `npm test`.
