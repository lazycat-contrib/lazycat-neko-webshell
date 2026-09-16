# Durable browser regressions

Run every required local browser scenario with:

```bash
npm run test:browser
```

Pass a scenario name after `--` to run it alone:

```bash
npm run test:browser -- herdr-history
npm run test:browser -- mobile-layout
npm run test:browser -- mobile-keyboard
npm run test:browser -- workspace-sync
npm run test:browser -- herdr-pointer
```

The aggregator first checks that its isolated `agent-browser` driver preserves an opened page
across CLI commands. It then runs each requested scenario sequentially and requires an explicit
`status: "passed"` result; missing modules, missing prerequisites, and skipped scenarios fail.

- [Herdr history](herdr-history/README.md) covers promise-backed clipboard writes, modal-local
  fallback, permission errors, focus cycling and narrow-screen UI.
- [Mobile layout](mobile-layout/README.md) covers custom-key edit/undo/preview, touch reorder
  and accessible controls at mobile and desktop widths.
- [Mobile keyboard](mobile-keyboard/README.md) covers swipe cancellation, release-only taps,
  held-key repeat cancellation, keyboard activation and synchronous system-keyboard actions.
- [Workspace sync](workspace-sync/README.md) covers request ownership, incremental reconciliation,
  passive two-browser convergence, and real agent/PTY output.
- [Herdr pointer](herdr-pointer/README.md) covers the Restty touch baseline, WebShell's paired
  Herdr touch adapter, native mouse and gesture boundaries, and Herdr's native new-tab prompt.

Runtime evidence is stored under ignored `tests-auto/artifacts/`. These are isolated local-browser
checks, not remote LightOS or physical-device certification; each scenario README states its exact
prerequisites and limits.

The separate [Herdr API smoke](herdr-api/README.md) validates the new SockAPI methods against an isolated real Herdr 0.9 server.

无桌面显示服务的环境可设置 `NEKO_BROWSER_HEADLESS=1` 运行浏览器回归，例如 `NEKO_BROWSER_HEADLESS=1 npm run test:browser -- mobile-keyboard mobile-layout mobile-workflow`。
