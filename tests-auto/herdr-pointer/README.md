# Herdr pointer browser regression

This scenario runs the real Restty 0.3.0 renderer against a real Herdr 0.8.2 monolithic PTY in a
headed Chromium session. It records the known Restty touch baseline and verifies the WebShell
Herdr pointer adapter end to end.

## Prerequisites

- `herdr 0.8.2` on `PATH`, or `HERDR_TEST_BINARY=/path/to/herdr`
- `agent-browser` with its Chromium installed
- Python 3 on `PATH`, or `PYTHON=/path/to/python3`
- Liberation Mono discoverable through `fc-match`, or `HERDR_TEST_FONT=/path/to/monospace.ttf`
- Linux headed browser support. On displayless machines, install Xvfb so `agent-browser --headed`
  can own a private display.

Run only this scenario:

```bash
npm run test:browser -- herdr-pointer
```

Run every durable browser scenario:

```bash
npm run test:browser
```

The runner preserves the caller's `HOME` but assigns isolated `HERDR_CONFIG_PATH`,
`HERDR_SOCKET_PATH`, and `XDG_CONFIG_HOME` paths under an owned temporary directory. Both bridge
ports are allocated by the operating system. Every subprocess call has a timeout and output cap.
Cleanup addresses only the named agent-browser session and the exact bridge/Herdr process groups
created by the scenario. The temporary state is removed after each run.

Evidence is written beneath ignored `tests-auto/artifacts/herdr-pointer/` directories. Each run
records structured metrics, browser errors, renderer/canvas evidence, and screenshots of the
baseline defect, corrected selection, and native new-tab prompt.

## Coverage

- Baseline without the adapter: a trusted CDP touch on the alpha workspace emits one SGR press,
  no release, and leaves beta focused. Supplying the matching mouse release focuses alpha.
- Adapter enabled: the same trusted touch emits exactly one SGR press/release pair and focuses
  alpha.
- Native CDP mouse input remains a press/release pair and focuses alpha.
- Drag/scroll, pointer cancellation, and a keyboard-claimed touch do not create phantom clicks.
- Disposing the adapter removes its synthesis behavior and returns to the one-press Restty baseline.
- Tapping Herdr's `+` opens its native new-tab prompt; Escape closes it and Enter accepts it.
- The fixture asserts a real WebGL2/WebGPU canvas, nonzero PTY bytes, animation frames, and
  nontrivial screenshots.

This is local Linux coverage. It does not validate remote LightOS transport, Android/iOS event
delivery, a physical touch device, browser chrome/IME behavior, or hardware GPU drivers. Those
remain explicit external-device checks.
