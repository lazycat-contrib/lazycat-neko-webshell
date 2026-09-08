# Mobile keyboard gesture regression

Run `npm run test:browser -- mobile-keyboard` (or `node tests-auto/mobile-keyboard/run.mjs`). Requires the installed Node dependencies and agent-browser/Chromium; no Herdr binary, target device or backend is contacted.

A real browser loads the production mobile keyboard controller and uses trusted CDP touch input over a horizontally scrollable key row. The suite verifies:

- Swipes over normal keys, repeat keys, custom text and action buttons emit nothing.
- Valid taps fire once; the resulting compatibility click does not duplicate activation.
- The system-keyboard action runs in the pointerup task with browser user activation intact. A timer installed by the fixture at pointerup capture detects accidental deferral to a later task.
- Keyboard Enter still activates a focused key through its synthesized click.
- Holding a repeat key starts repeat; movement or keyboard scrolling stops later repeats and prevents an extra release byte.
- Touch cancellation and controller disposal leave no key/click side effects.

Evidence is saved under ignored `tests-auto/artifacts/mobile-keyboard-<timestamp>/`: JSON event counts/phases and screenshots. Test data contains only known fixture keys and action identifiers. The runner owns a private browser session and local Vite server, and reports cleanup failures.

This proves browser event ordering and activation eligibility on local Chromium. It does not certify physical iOS/Android keyboard appearance, device-specific touch hardware or every browser's IME behavior. Deterministic Node tests cover fake-clock hold timing, multitouch, capture loss, visibility/page lifecycle, scroll boundaries and cleanup.
