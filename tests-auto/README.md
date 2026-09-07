# Durable browser regressions

Run every required local browser scenario with:

```bash
npm run test:browser
```

Pass a scenario name after `--` to run it alone:

```bash
npm run test:browser -- workspace-sync
npm run test:browser -- herdr-pointer
```

The aggregator first checks that its isolated `agent-browser` driver preserves an opened page
across CLI commands. It then runs each requested scenario sequentially and requires an explicit
`status: "passed"` result; missing modules, missing prerequisites, and skipped scenarios fail.

- [Workspace sync](workspace-sync/README.md) covers request ownership, incremental reconciliation,
  passive two-browser convergence, and real agent/PTY output.
- [Herdr pointer](herdr-pointer/README.md) covers the Restty touch baseline, WebShell's paired
  Herdr touch adapter, native mouse and gesture boundaries, and Herdr's native new-tab prompt.

Runtime evidence is stored under ignored `tests-auto/artifacts/`. These are isolated local-browser
checks, not remote LightOS or physical-device certification; each scenario README states its exact
prerequisites and limits.
