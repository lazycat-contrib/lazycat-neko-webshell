# Terminal output benchmark: Restty 0.3.0

## Decision

Retain one WebSocket per pane and the current terminal protocol for this release. Do not add a consumption ACK from renderer-only evidence.

The measured local browser path had no sequence gaps, no server-side WebSocket buffering, and acceptable input marker latency under the tested replay and continuous-output loads. A negotiated consumption ACK would add compatibility and recovery state without addressing the observed software-renderer frame stalls. This decision is deliberately limited: production flow control remains undecided until the same workload is measured through LightOS, the Rust provider, the remote agent/PTY and a realistic network.

## Repeatable command

```bash
node scripts/benchmark-terminal-output.mjs \
  --repetitions 3 \
  --warmups 1 \
  --continuous-ms 2000 \
  --output tests-auto/performance/artifacts/baseline-restty-0.3.0.json \
  --screenshot tests-auto/performance/artifacts/baseline-restty-0.3.0.png
```

The runner binds an ephemeral `127.0.0.1` port, serves only the benchmark fixture, Restty distribution files and a local font, and opens one real loopback WebSocket per pane. It launches an isolated headed agent-browser session with software WebGL2, uses `/usr/share/fonts/liberation/LiberationMono-Regular.ttf` by default, and closes its browser, sockets and server in `finally`. Every CLI process uses the shared bounded browser driver with a 30-second deadline and 512 KiB output cap. A failed run writes its error, active scenario and completed partial results before cleanup. Override the font with `TERMINAL_BENCHMARK_FONT=/absolute/font.ttf`.

For a shorter diagnostic run, filter cases with `--panes 1` and/or `--workloads replay,continuous`. Artifacts are ignored under `tests-auto/performance/artifacts/`.

## Workloads and metrics

- Small: 16 KiB per pane in four frames.
- Replay: exactly 350 KiB per pane in 22 frames, delivered as a burst.
- Continuous: 4 KiB every 32 ms for two seconds, 252 KiB per pane and 63 frames.
- One and four panes use independent public Restty PTY transport connections and independent WebSockets.
- Restty runtime lifecycle and `term-size` callbacks gate readiness and report the real grid. The wrapper's static `term.cols`/`term.rows` values are not used as evidence.
- `receiveCompleteMs` ends at the final WebSocket marker. `rendererSettledMs` waits for final receive and all input marker acknowledgments, then two animation frames. It therefore includes input echo latency and paint opportunities; it is neither a pure render-tail measurement nor an internal renderer acknowledgment.
- `maxBytesAwaitingPaintOpportunity` counts bytes delivered to Restty since the previous animation frame. It is a harness-visible upper bound, not Restty internal queue memory.
- Input markers use `sendKeyInput`, traverse the WebSocket, and are echoed by the server. Small/replay markers are scheduled after this fixture's receive-complete marker; continuous markers are scheduled halfway through the stream. This ordering describes the harness only and does not assert that production input-before-replay-ready behavior was measured.
- Sequence gaps, server `bufferedAmount`, backpressure events, browser outgoing `bufferedAmount`, frame intervals and heap deltas are recorded in the JSON artifact.

## Environment

- Restty 0.3.0, agent-browser 0.36.0, Node 26.8.1.
- Headed Chromium under Xvfb with `--use-gl=angle,--use-angle=swiftshader,--enable-unsafe-swiftshader`.
- The runtime reported WebGL2 on ANGLE's Vulkan SwiftShader renderer.
- Grid callbacks reported 157×51 for one pane and 78×25 for each pane in the four-pane grid.
- Three recorded runs per case plus one separately retained first iteration. The first iteration is a new page/runtime; browser code, shader and font caches may already be warm after earlier cases, so it is not a clean-process cold start.

## Results

Medians are shown unless marked p95/max.

| Panes | Workload | Total output | Receive | ACK + two paints | Input ACK p95 | Peak awaiting paint | Gaps | Sockets |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Small | 16 KiB | 11.1 ms | 185.5 ms | 21.5 ms | 16 KiB | 0 | 1 |
| 1 | Replay | 350 KiB | 24.5 ms | 186.1 ms | 0.8 ms | 350 KiB | 0 | 1 |
| 1 | Continuous | 252 KiB | 2016.4 ms | 2207.7 ms | 7.0 ms | 24 KiB | 0 | 1 |
| 4 | Small | 64 KiB | 34.1 ms | 111.9 ms | 51.4 ms | 64 KiB | 0 | 4 |
| 4 | Replay | 1400 KiB | 122.5 ms | 204.0 ms | 63.2 ms | 1400 KiB | 0 | 4 |
| 4 | Continuous | 1008 KiB | 2017.0 ms | 2117.5 ms | 28.8 ms | 304 KiB | 0 | 4 |

Recorded `rendererSettledMs` p95/max was 270.3 ms for one-pane small, 266.9 ms for one-pane replay, 2213.1 ms for one-pane continuous, 243.3 ms for four-pane small, 567.9 ms for four-pane replay, and 2260.8 ms for four-pane continuous. These values include marker acknowledgments and two paint opportunities; continuous values also include the two-second stream duration.

The separately retained first iterations settled in 185.2/111.1/2032.6 ms for one pane and 236.9/138.6/2376.4 ms for four panes (small/replay/continuous). The worst first-iteration input marker was 104.7 ms in the four-pane small case.

All recorded runs had zero sequence gaps, zero server backpressure events above 256 KiB and a maximum server `bufferedAmount` of zero. Input dispatch into Restty's transport callback stayed at or below 0.2 ms. Four-pane continuous output showed animation-frame stalls up to 400 ms under SwiftShader, while its input ACK remained below 29 ms p95. This points to software rendering/scheduling rather than socket congestion; repeat on hardware GPU before making renderer pacing changes.

## Actionable limits and follow-up

The loopback fixture exercises browser WebSocket decoding, Restty parsing, WASM state, WebGL2 scheduling and one-versus-four connection overhead. It does not exercise production TLS, LightOS forwarding, provider send deadlines, agent framing, PTY reads, WAN latency or kernel queues across machines. It therefore cannot show whether bytes accumulate before reaching the browser and cannot justify a universal conclusion that ACKs are unnecessary.

Use the same output sizes in a real target benchmark and record provider/agent queued bytes plus browser consumed cursors. Add a negotiated, generation-scoped ACK only if that run shows sustained unbounded upstream growth, replay starvation or input latency that correlates with outstanding bytes. Validate stale/future ACK rejection and timeout recovery before enabling it. Keep separate pane sockets; multiplexing is not required for per-pane backpressure.

The four-pane screenshot in the ignored artifact directory was visually checked and contains four rendered Liberation Mono WebGL2 terminals. Heap deltas varied with garbage collection and were retained in raw data but excluded from the protocol decision.
