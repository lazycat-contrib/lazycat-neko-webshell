# Terminal reliability upgrade

The user approved all findings from the September 7 comparison with lazycat-microserver-webshell, the Herdr click investigation, Restty upgrade, then an application version bump, commit, push and new version tag.

## Required behavior

1. Pin Restty 0.3.0 for browser and embedded headless WASM. Validate imports, ABI and SHA. Provide the new env.now_ms monotonic clock. Agent runtime changes increment AGENT_VERSION; compatible older agents remain accepted unless evidence requires raising MIN_SUPPORTED_AGENT_VERSION. Application release is separately versioned.
2. Reading partial agent frames must survive concurrent browser input/control events. Socket writes and attach cleanup are bounded, without killing persistent remote PTYs.
3. Workspace mutations cannot be superseded by focus persistence or stale reads. Serialize structural mutations per selector, retain latest local focus, and reject responses belonging to a replaced target/lifecycle.
4. Ordinary workspace reconciliation preserves unchanged tab/pane DOM, terminal, transport, selection and pending input. Full reset remains explicit for changed session/backend/reply authority/history identity.
5. A visible page discovers other devices' normal workspace tab/pane membership changes. Coalesce bounded refreshes, preserve local focus and geometry, suspend when hidden/offline and clean up listeners/timers. Avoid creating tabs or restarting sessions during passive reads. Pure rename/layout updates should also converge when returned by a passive snapshot.
6. Herdr touch/click works end-to-end for workspace selection and the + button. Preserve application mouse coordinates, native mouse, shift-selection, touch scroll and double-tap keyboard behavior; track cancellation and disposal. The observed Restty touch pointerup early-return is a confirmed event-level defect, not yet proof of every reporter scenario.
7. Provide bounded, opt-in, privacy-preserving per-pane diagnostic timelines for connect/replay/ready/resize/recovery, with an export available under existing debug mode. Never log input/output text, secrets or credential-bearing URLs.
8. Add repeatable real browser regression coverage and failure artifacts for Herdr clicks, workspace mutation/focus races, passive multi-device sync and terminal lifecycle/output. Use an isolated local runtime where possible; distinguish local coverage from remote LightOS/mobile-device coverage.
9. Measure multi-pane continuous output and recovery with a repeatable benchmark. Add negotiated consumption ACK/byte windows only if measurements support them; a documented measured decision to retain separate sockets is valid. Do not copy the whole Go broker without need.
10. Verify, update release metadata, commit, push main and a new version tag (expected v0.7.29, verify remote availability), and follow its CI.

## Boundaries

Follow AGENTS.md: main.ts remains composition and orchestration; focused workspace/terminal modules own algorithms. Mobile-only behavior lives under mobile/. Preserve directional Herdr allowlisting/handoff and independent agent upgrade policy. No external plugin marketplace, destructive session reset, automatic Herdr handoff or unrelated infrastructure changes. Keep tests meaningful and focused; collect runtime evidence before declaring a UI defect fixed.
