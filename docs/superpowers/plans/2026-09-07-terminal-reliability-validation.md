# Terminal reliability validation

The September 7 upgrade uses Restty 0.3.0 in the browser and target agent. Its pinned WASM needs a monotonic `env.now_ms` clock and SIMD support; the import/export ABI, hash, memory limits and fuel limits are verified. Agent implementation version is 13, minimum compatible version remains 11, and protocol remains v4.

## Runtime contracts

- Optional SNAPSHOT requests observe an existing agent without installing, starting, recovering, resizing or changing history limits. They wait for an ongoing recovery transaction and report transient unavailability when persisted state has not yet been explicitly restored. Older compatible agents return unsupported capability; they are not replaced solely for this feature.
- Browser structural mutations and focus persistence have separate ordered lanes. Passive snapshots cannot override a mutation or local focus. Unchanged tab/pane DOM and terminal runtime identities survive reconciliation.
- Agent output is decoded by one bounded reader. Input/control events cannot cancel partial frames. Socket writes, attach input and cleanup have deadlines; an attach ending does not terminate its persistent remote PTY.
- Herdr touch taps are translated through the renderer's native mouse encoder as matched press/release events. Scrolling, long press, multiple touches, cancelled gestures and replay transitions cannot leave an unmatched application press.
- Debug timelines contain anonymous pane numbers, event names and bounded allowlisted metrics. They do not include commands, terminal output, target paths or authentication data. Receive, renderer submission and input readiness remain distinct events; readiness is not claimed to be GPU presentation.

## Repeatable checks

```sh
npm test
npm run typecheck
npm run build
node scripts/export-restty-wasm.mjs
cargo fmt --check
cargo test --locked
npm run test:browser
node scripts/benchmark-terminal-output.mjs
```

The browser runner covers separate workspace and Herdr scenarios, each with its own README, temporary runtime and ignored failure artifacts. Workspace scenarios use actual Rust agent/protobuf/PTY/WebSocket traffic and the production frontend controllers. Herdr scenarios use a separate Herdr configuration/socket and actual browser pointer events. They do not modify live user sessions.

The browser fixtures bypass LightOS deployment authorization and simplify outer application chrome. Their results do not certify physical mobile hardware, an installed LightOS package, weak-network fairness or multi-device resize on a remote target. Those boundaries remain explicit instead of being represented as successful mocks.

## Release candidate result

The 0.7.29 LPK build passed 417 frontend tests, four release tests, and 432 Rust tests. The two normally ignored Rust entries are the same release-mode performance gate compiled in two binaries; its explicit optimized agent run passed with 1.779 ms median per 8 KiB batch and 1.111x cadence overhead (limit 1.25x).

The required browser aggregator passed the driver navigation smoke, four workspace scenarios and the Herdr pointer scenario. The output benchmark completed 24 browser iterations; its limits and measured decision are in `2026-09-07-terminal-output-benchmark.md`.

The built LPK was inspected for version 0.7.29, the WebShell resource export, executable provider and Restty 0.3.0 license. Its provider bytes matched the independently built binary. The packaged provider reported agent protocol v4, implementation version 13 and minimum compatible version 11.
