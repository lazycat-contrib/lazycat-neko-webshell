# Mobile workflow regression

Run `node tests-auto/mobile-workflow/run.mjs`, or `NEKO_BROWSER_HEADLESS=1 npm run test:browser -- mobile-workflow` without an X display.

The Vite fixture renders the production application shell, mobile keyboard/gesture and system-keyboard controllers, composer, palette, target/dispatch adapter and overview. Terminal transport is simulated; only synthetic draft and phrase data are used. Real Chromium touch sequences verify menu opening cannot click through to a submit button, arrows and hold cancellation, exact multiline bytes and explicit Enter, per-target draft retention, failed/pending sends, search/recency/changed choices, unchanged-refresh focus, overview selection and custom layout preservation. Screenshots cover 390px and 320px widths.

Separate dispatch unit tests check split bracketed-paste mode sequences and Herdr focus changes during async readiness. The suite does not emulate an actual iOS keyboard or a live remote Herdr server; physical-device IME and viewport behavior still need device testing.
