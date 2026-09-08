# Herdr machine manager browser checks

Run `node tests-auto/herdr-machines/run.mjs` after installing the project's Node dependencies and `agent-browser` with Chromium.

The runner starts an isolated Vite fixture using the production manager and Restty renderer. HTTP and SSH setup traffic are simulated; it never contacts or modifies an actual SSH machine. It checks config/manual drafts, optional connection tests, terminal output and control keys, suppression of local password echo, rename/toggle/remove, keyboard focus, small viewports and target-change cancellation. Screenshots go under `tests-auto/artifacts/herdr-machines/`.

Live LightOS authorization and remote Herdr installation remain integration checks for a device environment. Existing target SSH Host discovery reads the main `~/.ssh/config`; aliases declared only in Include files can be entered manually and are resolved by OpenSSH when connecting.
