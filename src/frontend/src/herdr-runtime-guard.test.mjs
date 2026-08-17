import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrRuntimeGuard, herdrRuntimeGuardPresentation } from "./herdr-runtime-guard.ts";

const tr = (key, values = {}) => `${key}:${values.client ?? ""}:${values.server ?? ""}`;
const status = {
  selector: "demo@owner",
  client_version: "0.8.0",
  client_protocol: 20,
  server_version: "0.8.0",
  server_protocol: 19,
  state: "server_older",
  live_handoff_available: true,
};

test("offers handoff only when a newer client can replace an older server", () => {
  assert.deepEqual(herdrRuntimeGuardPresentation(status, tr), {
    hidden: false,
    message: "status.herdrServerOlder:20:19",
    handoffVisible: true,
  });
});

test("shows a shared in-progress handoff without offering a second mutation", () => {
  assert.deepEqual(herdrRuntimeGuardPresentation({ ...status, handoff_recent: true }, tr), {
    hidden: false,
    message: "status.herdrHandoffRunning::",
    handoffVisible: false,
  });
});

test("never offers handoff when the client is older than the server", () => {
  assert.deepEqual(herdrRuntimeGuardPresentation({
    ...status,
    state: "client_older",
    client_protocol: 19,
    server_protocol: 20,
  }, tr), {
    hidden: false,
    message: "status.herdrClientOlder:19:20",
    handoffVisible: false,
  });
});

test("hides the guard for matching and stopped runtimes", () => {
  for (const state of ["ready", "not_running"]) {
    assert.deepEqual(herdrRuntimeGuardPresentation({ ...status, state }, tr), {
      hidden: true,
      message: "",
      handoffVisible: false,
    });
  }
});

test("prepares a Herdr terminal by confirming handoff before attach", async () => {
  const events = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => {
      events.push(`status:${selector}`);
      return { ...status, selector };
    },
    handoff: async (selector) => {
      events.push(`handoff:${selector}`);
      return { ...status, selector, state: "ready", live_handoff_available: false };
    },
    confirm: async () => {
      events.push("confirm");
      return true;
    },
    onHandoffStart: (selector) => events.push(`start:${selector}`),
    onRecovered: (selector) => events.push(`recovered:${selector}`),
    onError: (message) => assert.fail(message),
  });

  const preparation = await guard.prepareTerminal("demo@owner", true);

  assert.deepEqual(preparation, { ready: true, retry: false });
  assert.deepEqual(events, [
    "status:demo@owner",
    "confirm",
    "status:demo@owner",
    "start:demo@owner",
    "handoff:demo@owner",
    "recovered:demo@owner",
  ]);
});

test("does not attach a Herdr terminal when handoff is declined", async () => {
  let handoffs = 0;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector }),
    handoff: async () => {
      handoffs += 1;
      return { ...status, state: "ready" };
    },
    confirm: async () => false,
    onRecovered: () => assert.fail("declined handoff must not recover"),
    onError: (message) => assert.fail(message),
  });

  assert.deepEqual(await guard.prepareTerminal("demo@owner", true), { ready: false, retry: false });
  assert.equal(handoffs, 0);
});

test("coalesces concurrent terminal preparations for the same selector", async () => {
  let fetches = 0;
  let resolveStatus;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: () => {
      fetches += 1;
      return new Promise((resolve) => { resolveStatus = resolve; });
    },
    handoff: async () => assert.fail("matching protocols must not hand off"),
    confirm: async () => assert.fail("matching protocols must not prompt"),
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  const first = guard.prepareTerminal("demo@owner");
  const second = guard.prepareTerminal("demo@owner");
  resolveStatus({ ...status, state: "ready", selector: "demo@owner" });

  assert.deepEqual(await Promise.all([first, second]), [
    { ready: true, retry: false },
    { ready: true, retry: false },
  ]);
  assert.equal(fetches, 1);
});

test("marks transient runtime inspection failures for pane reconnect", async () => {
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async () => { throw new Error("temporary status failure"); },
    handoff: async () => assert.fail("failed inspection must not hand off"),
    confirm: async () => assert.fail("failed inspection must not prompt"),
    onRecovered: () => {},
    onError: () => {},
  });

  assert.deepEqual(await guard.prepareTerminal("demo@owner"), { ready: false, retry: true });
});

test("serializes confirmation across selectors without cancelling the first prompt", async () => {
  let confirms = 0;
  let resolveConfirm;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector }),
    handoff: async () => assert.fail("declined and deferred handoffs must not run"),
    confirm: () => {
      confirms += 1;
      return new Promise((resolve) => { resolveConfirm = resolve; });
    },
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  const first = guard.prepareTerminal("first@owner", true);
  await Promise.resolve();
  const second = await guard.prepareTerminal("second@owner");
  resolveConfirm(false);

  assert.deepEqual(second, { ready: false, retry: true });
  assert.deepEqual(await first, { ready: false, retry: false });
  assert.equal(confirms, 1);
});

test("waits without prompting while another provider handoff is recent", async () => {
  let confirms = 0;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector, handoff_recent: true }),
    handoff: async () => assert.fail("recent handoff must not be duplicated"),
    confirm: async () => {
      confirms += 1;
      return true;
    },
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  assert.deepEqual(await guard.prepareTerminal("demo@owner", true), { ready: false, retry: true });
  assert.equal(confirms, 0);
});

test("revalidates a newly recent handoff after confirmation without posting", async () => {
  let fetches = 0;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => ({
      ...status,
      selector,
      handoff_recent: ++fetches > 1,
    }),
    handoff: async () => assert.fail("revalidated recent handoff must not be duplicated"),
    confirm: async () => true,
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  assert.deepEqual(await guard.prepareTerminal("demo@owner", true), { ready: false, retry: true });
});

test("does not hand off a stale terminal target after navigation during confirmation", async () => {
  let resolveConfirm;
  const handoffs = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector }),
    handoff: async (selector) => {
      handoffs.push(selector);
      return { ...status, selector, state: "ready" };
    },
    confirm: () => new Promise((resolve) => { resolveConfirm = resolve; }),
    onRecovered: () => assert.fail("stale target must not recover"),
    onError: (message) => assert.fail(message),
  });

  const preparation = guard.prepareTerminal("first@owner", true);
  await Promise.resolve();
  guard.sync("second@owner", { available: true, herdr_protocol: 19 });
  resolveConfirm(true);

  assert.deepEqual(await preparation, { ready: false, retry: true });
  assert.deepEqual(handoffs, []);
});

test("retries a stale terminal target when navigation dismisses its confirmation", async () => {
  let resolveConfirm;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector }),
    handoff: async () => assert.fail("dismissed stale target must not hand off"),
    confirm: () => new Promise((resolve) => { resolveConfirm = resolve; }),
    onRecovered: () => assert.fail("dismissed stale target must not recover"),
    onError: (message) => assert.fail(message),
  });

  const preparation = guard.prepareTerminal("first@owner", true);
  await Promise.resolve();
  guard.sync("second@owner", { available: true, herdr_protocol: 19 });
  resolveConfirm(false);

  assert.deepEqual(await preparation, { ready: false, retry: true });
});

test("keeps preparation recovery protected while a lost handoff response settles", async () => {
  let fetches = 0;
  const recovered = [];
  const failed = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => {
      fetches += 1;
      return fetches < 4
        ? { ...status, selector }
        : { ...status, selector, state: "ready", live_handoff_available: false };
    },
    handoff: async () => { throw new Error("response lost"); },
    confirm: async () => true,
    onHandoffFailed: (selector) => failed.push(selector),
    onRecovered: (selector) => recovered.push(selector),
    onError: () => {},
    wait: async () => {},
    uncertainReconcileAttempts: 2,
  });

  assert.deepEqual(
    await guard.prepareTerminal("demo@owner", true),
    { ready: false, retry: true },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(recovered, ["demo@owner"]);
  assert.deepEqual(failed, []);
});

test("reports a running server whose protocol is unknown without offering handoff", () => {
  assert.deepEqual(herdrRuntimeGuardPresentation({
    ...status,
    state: "unknown",
    server_protocol: undefined,
    live_handoff_available: false,
  }, tr), {
    hidden: false,
    message: "status.herdrProtocolUnknown::",
    handoffVisible: false,
  });
});

test("inspects runtime status even when SockAPI is unavailable", async () => {
  let fetched = "";
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => {
      fetched = selector;
      return { ...status, selector };
    },
    handoff: async () => assert.fail("handoff should not run"),
    confirm: async () => false,
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  guard.sync("demo@owner", { available: false });
  await Promise.resolve();

  assert.equal(fetched, "demo@owner");
});

test("forced status refresh does not create a duplicate refresh on unchanged bridge state", async () => {
  let fetches = 0;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: () => {} },
    },
    tr,
    fetchStatus: async (selector) => {
      fetches += 1;
      return { ...status, selector };
    },
    handoff: async () => assert.fail("handoff should not run"),
    confirm: async () => false,
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });
  const bridgeState = { available: true, herdr_protocol: 19 };

  guard.sync("demo@owner", bridgeState);
  await Promise.resolve();
  await guard.refresh();
  guard.sync("demo@owner", bridgeState);
  await Promise.resolve();

  assert.equal(fetches, 2);
});

test("does not hand off a different target after navigation during confirmation", async () => {
  let click;
  let resolveConfirm;
  const handoffCalls = [];
  const handoff = {
    hidden: false,
    disabled: false,
    addEventListener: (_event, listener) => { click = listener; },
  };
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff,
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector }),
    handoff: async (selector) => {
      handoffCalls.push(selector);
      return { ...status, selector, state: "ready", live_handoff_available: false };
    },
    confirm: () => new Promise((resolve) => { resolveConfirm = resolve; }),
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  guard.sync("first@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  guard.sync("second@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  resolveConfirm(true);
  await Promise.resolve();

  assert.deepEqual(handoffCalls, []);
});

test("hides stale handoff state immediately when switching targets", async () => {
  let click;
  let resolveSecondStatus;
  const handoffCalls = [];
  const handoff = {
    hidden: false,
    disabled: false,
    addEventListener: (_event, listener) => { click = listener; },
  };
  const guard = createHerdrRuntimeGuard({
    elements: { root: { hidden: true }, message: { textContent: "" }, handoff },
    tr,
    fetchStatus: (selector) => selector === "first@owner"
      ? Promise.resolve({ ...status, selector })
      : new Promise((resolve) => { resolveSecondStatus = resolve; }),
    handoff: async (selector) => {
      handoffCalls.push(selector);
      return { ...status, selector, state: "ready", live_handoff_available: false };
    },
    confirm: async () => true,
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  guard.sync("first@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  assert.equal(handoff.hidden, false);
  guard.sync("second@owner", { available: true, herdr_protocol: 19 });
  assert.equal(handoff.hidden, true);
  click();
  await Promise.resolve();

  assert.deepEqual(handoffCalls, []);
  resolveSecondStatus({ ...status, selector: "second@owner" });
});

test("hides stale handoff state during a same-target bridge revision refresh", async () => {
  let click;
  let resolveRefresh;
  let fetches = 0;
  const handoffCalls = [];
  const handoff = {
    hidden: false,
    disabled: false,
    addEventListener: (_event, listener) => { click = listener; },
  };
  const guard = createHerdrRuntimeGuard({
    elements: { root: { hidden: true }, message: { textContent: "" }, handoff },
    tr,
    fetchStatus: async (selector) => {
      fetches += 1;
      if (fetches === 1) return { ...status, selector };
      return new Promise((resolve) => { resolveRefresh = resolve; });
    },
    handoff: async (selector) => {
      handoffCalls.push(selector);
      return { ...status, selector, state: "ready", live_handoff_available: false };
    },
    confirm: async () => true,
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  guard.sync("demo@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  assert.equal(handoff.hidden, false);
  guard.sync("demo@owner", { available: true, herdr_protocol: 20 });
  assert.equal(handoff.hidden, true);
  click();
  await Promise.resolve();

  assert.deepEqual(handoffCalls, []);
  resolveRefresh({ ...status, selector: "demo@owner" });
});

test("does not hand off from stale status after a same-target refresh starts", async () => {
  let click;
  let resolveConfirm;
  let resolveRefresh;
  let fetchCount = 0;
  const handoffCalls = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: {
        hidden: false,
        disabled: false,
        addEventListener: (_event, listener) => { click = listener; },
      },
    },
    tr,
    fetchStatus: async (selector) => {
      fetchCount += 1;
      if (fetchCount === 1) return { ...status, selector };
      return new Promise((resolve) => { resolveRefresh = resolve; });
    },
    handoff: async (selector) => {
      handoffCalls.push(selector);
      return { ...status, selector, state: "ready", live_handoff_available: false };
    },
    confirm: () => new Promise((resolve) => { resolveConfirm = resolve; }),
    onRecovered: () => {},
    onError: (message) => assert.fail(message),
  });

  guard.sync("demo@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  void guard.refresh();
  await Promise.resolve();
  resolveConfirm(true);
  await Promise.resolve();
  resolveRefresh({ ...status, selector: "demo@owner" });
  await Promise.resolve();

  assert.deepEqual(handoffCalls, []);
});

test("recovers the confirmed target when navigation happens during handoff", async () => {
  let click;
  let resolveHandoff;
  const recovered = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: {
        hidden: false,
        disabled: false,
        addEventListener: (_event, listener) => { click = listener; },
      },
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector }),
    handoff: () => new Promise((resolve) => { resolveHandoff = resolve; }),
    confirm: async () => true,
    onRecovered: (selector) => { recovered.push(selector); },
    onError: (message) => assert.fail(message),
  });

  guard.sync("first@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  await new Promise((resolve) => setImmediate(resolve));
  guard.sync("second@owner", { available: true, herdr_protocol: 19 });
  resolveHandoff({
    ...status,
    selector: "first@owner",
    state: "ready",
    live_handoff_available: false,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(recovered, ["first@owner"]);
});

test("reports handoff start and failure for pane recovery bookkeeping", async () => {
  let click;
  const started = [];
  const failed = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: {
        hidden: false,
        disabled: false,
        addEventListener: (_event, listener) => { click = listener; },
      },
    },
    tr,
    fetchStatus: async (selector) => ({ ...status, selector }),
    handoff: async () => { throw new Error("handoff failed"); },
    confirm: async () => true,
    onHandoffStart: (selector) => { started.push(selector); },
    onHandoffFailed: (selector) => { failed.push(selector); },
    onRecovered: () => assert.fail("failed handoff must not recover"),
    onError: () => {},
    wait: async () => {},
    uncertainReconcileAttempts: 1,
  });

  guard.sync("demo@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(started, ["demo@owner"]);
  assert.deepEqual(failed, ["demo@owner"]);
});

test("reconciles a lost handoff response that already committed", async () => {
  let click;
  let fetches = 0;
  const recovered = [];
  const failed = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: (_event, listener) => { click = listener; } },
    },
    tr,
    fetchStatus: async (selector) => {
      fetches += 1;
      return fetches === 1
        ? { ...status, selector }
        : { ...status, selector, state: "ready", live_handoff_available: false };
    },
    handoff: async () => { throw new Error("response lost"); },
    confirm: async () => true,
    onHandoffFailed: (selector) => { failed.push(selector); },
    onRecovered: (selector) => { recovered.push(selector); },
    onError: (message) => assert.fail(message),
  });

  guard.sync("demo@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(recovered, ["demo@owner"]);
  assert.deepEqual(failed, []);
});

test("fails a lost handoff response after bounded non-ready reconciliation", async () => {
  let click;
  const failed = [];
  let fetches = 0;
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: (_event, listener) => { click = listener; } },
    },
    tr,
    fetchStatus: async (selector) => {
      fetches += 1;
      return { ...status, selector };
    },
    handoff: async () => { throw new Error("request failed"); },
    confirm: async () => true,
    onHandoffFailed: (selector) => { failed.push(selector); },
    onRecovered: () => assert.fail("uncommitted handoff must not recover"),
    onError: () => {},
    wait: async () => {},
    uncertainReconcileAttempts: 1,
  });

  guard.sync("demo@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetches, 3);
  assert.deepEqual(failed, ["demo@owner"]);
});

test("keeps polling a non-ready handoff until it later reports ready", async () => {
  let click;
  let fetches = 0;
  const recovered = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: (_event, listener) => { click = listener; } },
    },
    tr,
    fetchStatus: async (selector) => {
      fetches += 1;
      if (fetches === 1) return { ...status, selector };
      if (fetches === 2) return { ...status, selector };
      return { ...status, selector, state: "ready", live_handoff_available: false };
    },
    handoff: async () => { throw new Error("response lost"); },
    confirm: async () => true,
    onHandoffFailed: () => assert.fail("uncertain handoff must remain pending"),
    onRecovered: (selector) => { recovered.push(selector); },
    onError: () => {},
    wait: async () => {},
    uncertainReconcileAttempts: 2,
  });

  guard.sync("demo@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(recovered, ["demo@owner"]);
});

test("bounds background reconciliation for an uncertain handoff", async () => {
  let click;
  let fetches = 0;
  const failed = [];
  const guard = createHerdrRuntimeGuard({
    elements: {
      root: { hidden: true },
      message: { textContent: "" },
      handoff: { hidden: false, disabled: false, addEventListener: (_event, listener) => { click = listener; } },
    },
    tr,
    fetchStatus: async (selector) => {
      fetches += 1;
      if (fetches === 1) return { ...status, selector };
      throw new Error("status unavailable");
    },
    handoff: async () => { throw new Error("response lost"); },
    confirm: async () => true,
    onHandoffFailed: (selector) => { failed.push(selector); },
    onRecovered: () => assert.fail("unresolved handoff must not recover"),
    onError: () => {},
    wait: async () => {},
    uncertainReconcileAttempts: 2,
  });

  guard.sync("demo@owner", { available: true, herdr_protocol: 19 });
  await Promise.resolve();
  click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetches, 4);
  assert.deepEqual(failed, ["demo@owner"]);
});
