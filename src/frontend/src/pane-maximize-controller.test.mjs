import assert from "node:assert/strict";
import test from "node:test";

import { createPaneMaximizeController } from "./pane-maximize-controller.ts";

function element(id, parent = null) {
  const values = new Set();
  return {
    dataset: id.startsWith("tab") ? { tabId: id } : { paneId: id },
    parentElement: parent,
    isConnected: true,
    classList: {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      contains: (name) => values.has(name),
    },
  };
}

test("maximizes through CSS path markers and restores without moving nodes", () => {
  const tab = element("tab-one");
  const outer = element("outer", tab);
  const inner = element("inner", outer);
  const pane = element("pane-one", inner);
  const controller = createPaneMaximizeController();
  assert.equal(controller.toggle(tab, pane), true);
  assert.equal(controller.allowsPane("pane-one"), true);
  assert.equal(controller.allowsPane("pane-two"), false);
  assert.equal(tab.classList.contains("pane-maximized"), true);
  assert.equal(outer.classList.contains("pane-maximize-path"), true);
  assert.equal(inner.classList.contains("pane-maximize-path"), true);
  assert.equal(pane.classList.contains("pane-maximized-target"), true);
  assert.equal(controller.toggle(tab, pane), false);
  assert.equal(controller.allowsPane("pane-two"), true);
  assert.equal(tab.classList.contains("pane-maximized"), false);
  assert.equal(pane.parentElement, inner);
});

test("clears maximization when the active pane changes", () => {
  const tab = element("tab-one");
  const pane = element("pane-one", tab);
  const other = element("pane-two", tab);
  const controller = createPaneMaximizeController();
  controller.toggle(tab, pane);
  controller.sync(tab, other);
  assert.equal(controller.isMaximized(), false);
  assert.equal(tab.classList.contains("pane-maximized"), false);
});
