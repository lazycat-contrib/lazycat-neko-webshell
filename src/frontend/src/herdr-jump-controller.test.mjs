import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrJumpController } from "./herdr-jump-controller.ts";

class FakeElement {
  constructor(tagName = "div", dataset = {}) {
    this.tagName = tagName.toUpperCase();
    this.dataset = { ...dataset };
    this.hidden = false;
    this.parentElement = undefined;
    this.listeners = new Map();
    this.style = {
      removeProperty() {},
      setProperty() {},
    };
  }

  appendTo(parent) {
    this.parentElement = parent;
    return this;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener() {}

  dispatch(type, target = this) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target });
    }
  }

  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (matchesSelector(element, selector)) return element;
    }
    return null;
  }

  contains(target) {
    for (let element = target; element; element = element.parentElement) {
      if (element === this) return true;
    }
    return false;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  removeAttribute(name) {
    delete this[name];
  }

  focus() {}
}

function matchesSelector(element, selector) {
  const match = /^(button)?\[data-([a-z-]+)\]$/.exec(selector);
  if (!match || (match[1] && element.tagName !== "BUTTON")) return false;
  const key = match[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return Object.hasOwn(element.dataset, key);
}

function installFakeDom(t) {
  const replacements = {
    Element: FakeElement,
    HTMLButtonElement: FakeElement,
    document: {
      activeElement: undefined,
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    requestAnimationFrame(callback) {
      callback();
      return 0;
    },
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, {
      present: Object.hasOwn(globalThis, key),
      value: globalThis[key],
    });
    globalThis[key] = value;
  }
  t.after(() => {
    for (const [key, entry] of previous) {
      if (entry.present) globalThis[key] = entry.value;
      else delete globalThis[key];
    }
  });
}

function controllerHarness() {
  const dock = new FakeElement("section", { herdrDensity: "normal" });
  const switcher = new FakeElement().appendTo(dock);
  const menu = new FakeElement().appendTo(switcher);
  menu.hidden = true;
  const currentTargets = new FakeElement().appendTo(dock);
  const focusedTabs = [];
  createHerdrJumpController({
    elements: {
      dock,
      switcher,
      trigger: new FakeElement("button").appendTo(switcher),
      menu,
      list: new FakeElement().appendTo(menu),
      status: new FakeElement().appendTo(menu),
      currentTargets,
      moreButton: new FakeElement("button").appendTo(dock),
      moreMenu: new FakeElement().appendTo(dock),
    },
    tr: (key) => key,
    createPlatform: () => ({
      device: () => "desktop",
      isMobile: () => false,
      onOpen() {},
      onClose() {},
      onDeviceChange() {},
      destroy() {},
    }),
    prepareMobileOverlay() {},
    updateIcons() {},
    refresh() {},
    focusWorkspace() {},
    focusTab: async (tabId) => focusedTabs.push(tabId),
    focusPane() {},
    createTab() {},
    createWorkspace() {},
    closeWorkspace() {},
  });
  return { dock, currentTargets, focusedTabs };
}

test("top Herdr tab clicks navigate even when the dock stores its display density", async (t) => {
  installFakeDom(t);
  const { dock, currentTargets, focusedTabs } = controllerHarness();
  const tabButton = new FakeElement("button", { herdrJumpTab: "w1:t2" }).appendTo(currentTargets);

  dock.dispatch("click", tabButton);
  await Promise.resolve();

  assert.deepEqual(focusedTabs, ["w1:t2"]);
});
