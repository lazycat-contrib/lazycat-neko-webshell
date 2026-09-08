import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrIntegrationsController } from "./controller.ts";
import { herdrIntegrationList, herdrIntegrationListSupported } from "./model.ts";
import { renderHerdrIntegrationsDialog } from "./view-render.ts";
import { herdrIntegrationsTabTarget, restoreHerdrIntegrationsFocus } from "./view-focus.ts";

const tick = async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};
const templates = { "integrations.command": "Command: {command}" };
const tr = (key, values = {}) => Object.entries(values).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
  templates[key] ?? key,
);

function response() {
  return {
    result: {
      type: "integration_list",
      integrations: [
        { target: "codex", label: "Codex", command: "codex", available: true, state: "current" },
        { target: "claude", label: "Claude", command: "claude", available: true, state: "outdated" },
        { target: "cursor", label: "Cursor", command: "cursor", available: false, state: "not_installed" },
      ],
    },
  };
}

test("parses the 0.9 integration states and rejects malformed or oversized status data", () => {
  assert.equal(herdrIntegrationListSupported("0.9.0"), true);
  assert.equal(herdrIntegrationListSupported("1.0.0-preview"), true);
  assert.equal(herdrIntegrationListSupported("0.8.2"), false);
  assert.deepEqual(herdrIntegrationList(response()).map((item) => item.state), [
    "current", "outdated", "not_installed",
  ]);
  assert.equal(herdrIntegrationList({ result: { integrations: [{ state: "future" }] } }), undefined);
  assert.equal(herdrIntegrationList({ result: { integrations: Array.from({ length: 65 }, () => ({})) } }), undefined);
});

test("renders backend labels and commands as escaped read-only status", () => {
  const html = renderHerdrIntegrationsDialog({
    state: "ready",
    integrations: [{
      target: "codex",
      label: "<img src=x onerror=alert(1)>",
      command: "codex && <unsafe>",
      available: true,
      state: "outdated",
    }],
  }, tr);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /codex &amp;&amp; &lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /integrations\.stateOutdated/);
  assert.doesNotMatch(html, /integration\.install|integration\.uninstall/);
});

test("hides the feature on old servers without sending a request", async () => {
  let requests = 0;
  const visibility = [];
  const controller = createHerdrIntegrationsController({
    target: () => ({ selector: "box", generation: 1 }),
    isCurrent: () => true,
    request: async () => { requests += 1; return response(); },
    present() {},
    closeView() {},
    setMenuVisible: (visible) => visibility.push(visible),
    invalidResponse: () => "invalid",
  });
  controller.sync({ available: true, herdr_version: "0.8.2" });
  await controller.open();
  assert.equal(requests, 0);
  assert.deepEqual(visibility, [false]);
});

test("drops a delayed status response after the target changes", async () => {
  const pending = deferred();
  let generation = 1;
  const screens = [];
  const closes = [];
  const controller = createHerdrIntegrationsController({
    target: () => ({ selector: "box", generation }),
    isCurrent: (target) => target.generation === generation,
    request: () => pending.promise,
    present: (screen) => screens.push(screen),
    closeView: (restore) => closes.push(restore),
    setMenuVisible() {},
    invalidResponse: () => "invalid",
  });
  controller.sync({ available: true, herdr_version: "0.9.0" });
  const opened = controller.open();
  await tick();
  generation = 2;
  pending.resolve(response());
  await opened;
  assert.deepEqual(screens.map((screen) => screen.state), ["loading"]);
  assert.deepEqual(closes, [false]);
});

test("an older completion cannot close a newer reopened integration view", async () => {
  const first = deferred();
  const second = deferred();
  let requests = 0;
  const screens = [];
  const closes = [];
  const controller = createHerdrIntegrationsController({
    target: () => ({ selector: "box", generation: 1 }),
    isCurrent: () => true,
    request: () => requests++ === 0 ? first.promise : second.promise,
    present: (screen) => screens.push(screen),
    closeView: (restore) => closes.push(restore),
    setMenuVisible() {},
    invalidResponse: () => "invalid",
  });
  controller.sync({ available: true, herdr_version: "0.9.0" });
  const older = controller.open();
  await tick();
  controller.close();
  const newer = controller.open();
  second.resolve(response());
  await newer;
  first.resolve(response());
  await older;
  assert.deepEqual(screens.map((screen) => screen.state), ["loading", "loading", "ready"]);
  assert.deepEqual(closes, [true]);
});

test("presents current integration status after a successful scoped read", async () => {
  const screens = [];
  const controller = createHerdrIntegrationsController({
    target: () => ({ selector: "box", generation: 1 }),
    isCurrent: () => true,
    request: async () => response(),
    present: (screen) => screens.push(screen),
    closeView() {},
    setMenuVisible() {},
    invalidResponse: () => "invalid",
  });
  controller.sync({ available: true, herdr_version: "0.9.0" });
  await controller.open();
  assert.deepEqual(screens.map((screen) => screen.state), ["loading", "ready"]);
  assert.deepEqual(screens[1].integrations.map((item) => item.target), ["codex", "claude", "cursor"]);
});

test("keeps a current request error inside the integration view", async () => {
  const screens = [];
  const controller = createHerdrIntegrationsController({
    target: () => ({ selector: "box", generation: 1 }),
    isCurrent: () => true,
    request: async () => { throw new Error("integration list unavailable"); },
    present: (screen) => screens.push(screen),
    closeView() {},
    setMenuVisible() {},
    invalidResponse: () => "invalid",
  });
  controller.sync({ available: true, herdr_version: "0.9.0" });
  await controller.open();
  assert.deepEqual(screens.map((screen) => screen.state), ["loading", "error"]);
  assert.equal(screens[1].message, "integration list unavailable");
});

test("cycles Tab boundaries inside the modal and restores connected focus", () => {
  const first = { id: "first" };
  const middle = { id: "middle" };
  const last = { id: "last" };
  const focusable = [first, middle, last];
  assert.equal(herdrIntegrationsTabTarget(focusable, last, false), first);
  assert.equal(herdrIntegrationsTabTarget(focusable, first, true), last);
  assert.equal(herdrIntegrationsTabTarget(focusable, middle, false), undefined);
  assert.equal(herdrIntegrationsTabTarget(focusable, undefined, false), first);

  let focusOptions;
  restoreHerdrIntegrationsFocus({
    isConnected: true,
    focus: (options) => { focusOptions = options; },
  });
  assert.deepEqual(focusOptions, { preventScroll: true });
  focusOptions = undefined;
  restoreHerdrIntegrationsFocus({
    isConnected: false,
    focus: (options) => { focusOptions = options; },
  });
  assert.equal(focusOptions, undefined);
});
