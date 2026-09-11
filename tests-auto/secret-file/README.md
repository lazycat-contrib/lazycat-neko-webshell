# Secret file browser regression

Run `node tests-auto/secret-file/run.mjs` with npm dependencies and `agent-browser` installed. The runner starts an isolated Vite fixture and browser session, and closes both when finished.

The fixture imports the production controller, view, styles, and mobile keyboard controller. Clipboard and HTTP responses use fictional test data; no real credentials or target files are accessed. Checks cover fresh entry before loading any plugin catalog, native Restty context-menu clicks for both WebShell and Herdr, desktop shortcuts, exact bytes, copy fallback inside the modal, insertion without Enter, target changes, reopening stored paths, mobile icon activation, empty/denied/pending clipboard fallback, late responses, and narrow layouts. Screenshots are saved under `tests-auto/artifacts/secret-file/`.

This does not replace testing OS clipboard permission prompts, physical mobile keyboards, or a live LightOS/SSH target.
