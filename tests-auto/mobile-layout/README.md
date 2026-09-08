# Mobile keyboard customization regression

Run `npm run test:browser -- mobile-layout`. The fixture loads the production layout editor and styles with local in-memory settings; it does not connect to a terminal or send commands.

Coverage includes arrow and trusted-touch reorder, focus after a move, visibility reflected in an inert preview, add/edit preserving escaped text and identity, delete/reset undo, oversized command rejection without draft loss, and 375px English/Chinese plus desktop layout checks. Each editor control must be at least 44px and the page must not overflow horizontally. Screenshots and results are stored under ignored `tests-auto/artifacts/mobile-layout/`.

This is local Chromium coverage, not a substitute for physical mobile-device testing. The browser session and Vite server are owned and closed by the runner.
