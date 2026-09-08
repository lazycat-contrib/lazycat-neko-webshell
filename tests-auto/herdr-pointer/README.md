# Herdr pointer browser regression

This scenario runs Restty 0.3.0 against a real Herdr **0.8.2 or 0.9.0 server and attached client** in headed Chromium. It verifies desktop workspace/tab switching, focus reporting and the WebShell touch adapter. It does not use the removed `--no-session` option.

## Run

Prerequisites: an explicit Herdr 0.8.2/0.9.0 binary, `agent-browser` with Chromium, Python 3, and Liberation Mono (`fc-match`). On displayless Linux, install Xvfb; agent-browser owns its private display. Set `PYTHON` or `HERDR_TEST_FONT` to override Python/font discovery.

Run both supported versions separately; `HERDR_TEST_BINARY` avoids a different binary earlier on `PATH` silently changing the case:

```bash
HERDR_TEST_BINARY=/path/to/herdr-0.8.2 npm run test:browser -- herdr-pointer
HERDR_TEST_BINARY=/path/to/herdr-0.9.0 npm run test:browser -- herdr-pointer
```

Without the override, the runner uses `herdr` from `PATH` and records its reported version. Run the complete local browser suite with `npm run test:browser`.

## Real transport initialization

The fixture waits for the runtime's `lifecycle.state()` to become `ready` before consuming any PTY output, including offset 0. It delivers output through the registered **transport `callbacks.onData`**, matching Neko. Direct `term.write()` bypasses Restty's input-mode tracking and previously hid DEC1004 focus reporting from these tests. The fixture also tracks real transport connection state so `connectPty` actually registers those callbacks.

Readiness requires real output delivery, an initialized runtime, active application mouse routing and an observed focus report. Failure artifacts include separate SGR mouse reports, focus reports, and their combined allowlisted order; arbitrary typed input is not included. Screenshot/canvas evidence remains required.

## Coverage

Desktop checks run **first**, so reverting the production focus-boundary fix fails on actual workspace switching before reaching the expected touch baseline:

- Native mouse down/up separated by 80–120 ms switches sidebar workspace beta→alpha.
- Herdr's native `+` prompt creates tab 2; desktop clicks switch tab 1→2, confirmed through the isolated server's tab state.
- Canvas↔IME transitions emit no `ESC[O`; focus-in reports prove tracking is active.
- A real canvas→outside-button DOM blur still forwards `ESC[O`. Only for this assertion, the fixture briefly disables its IME textarea to retain canvas focus and restores the disabled state in `finally`. No browser confirm/alert is used.
- Baseline without the touch adapter emits one SGR press and no release; supplying the matching release focuses alpha.
- With the adapter, trusted touch emits exactly one SGR pair and selects alpha.
- Native mouse still works after installing the touch adapter.
- Touch scroll, cancellation and keyboard-claimed gestures do not create phantom clicks; disposal removes touch synthesis.
- The native TUI new-tab prompt retains Escape/Enter behavior.

## Isolation and evidence

Each run creates a fresh temporary configuration/socket/XDG namespace. The bridge refuses a pre-existing config or socket. `HOME` remains available for normal binary behavior, but `HERDR_CONFIG_PATH`, `HERDR_SOCKET_PATH` and `XDG_CONFIG_HOME` are explicitly isolated. Ports are OS allocated; commands have timeouts/output limits.

Cleanup sends `server stop` using that exact binary and isolated environment, covering Herdr 0.9's detached daemon. It then terminates only the PTY child/bridge process groups created by this run, even if graceful server shutdown fails. The runner allows the bounded shutdown budget to complete before escalation, closes only its named browser session, and removes only its owned temporary directory.

Ignored `tests-auto/artifacts/herdr-pointer/<run>/` directories contain `metrics.json`, `errors.json`, desktop workspace/tab screenshots, the touch baseline/corrected screenshots, and the native prompt screenshot. A prerequisite failure or skipped case is not reported as passed.

This validates local Linux/Chromium with a real Herdr client/server and production terminal factory. It does not certify remote LightOS transport, physical mouse/touch devices, Android/iOS, hardware GPU drivers, or every desktop browser. Those require separate device coverage.
