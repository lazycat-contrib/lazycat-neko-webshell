# OSC 7501 browser regression

`NEKO_BROWSER_HEADLESS=1 npm run test:browser -- program-status`

Starts the real target agent with generic PTYs. A native mock program probes OSC
7501 and emits working/blocked/done/clear records. Two independent browsers must
converge and reconnect to the current status without replaying old transitions.
Mock executables also exercise automatic native-name and Node package-path
detection without running paid or authenticated coding agents. Screenshots cover
desktop and mobile tabs using the production Herdr icons/status presentation.
