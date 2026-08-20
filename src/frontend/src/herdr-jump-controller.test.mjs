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
    parent.children ??= [];
    parent.children.push(this);
    return this;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener() {}

  dispatch(type, target = this, init = {}) {
    const event = {
      target,
      preventDefault() {},
      stopPropagation() {},
      ...init,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
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

  focus() {
    document.activeElement = this;
  }
}

function matchesSelector(element, selector) {
  if (selector === "[hidden]") return element.hidden;
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
  const moreButton = new FakeElement("button").appendTo(dock);
  const moreMenu = new FakeElement().appendTo(dock);
  moreMenu.hidden = true;
  const focusedTabs = [];
  const consoleActions = [];
  createHerdrJumpController({
    elements: {
      dock,
      switcher,
      trigger: new FakeElement("button").appendTo(switcher),
      menu,
      list: new FakeElement().appendTo(menu),
      status: new FakeElement().appendTo(menu),
      currentTargets,
      moreButton,
      moreMenu,
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
    runConsoleAction: async (action) => consoleActions.push(action),
  });
  return { dock, currentTargets, focusedTabs, consoleActions, moreButton, moreMenu };
}

test("top Herdr tab clicks navigate even when the dock stores its display density", async (t) => {
  installFakeDom(t);
  const { dock, currentTargets, focusedTabs } = controllerHarness();
  const tabButton = new FakeElement("button", { herdrJumpTab: "w1:t2" }).appendTo(currentTargets);

  dock.dispatch("click", tabButton);
  await Promise.resolve();

  assert.deepEqual(focusedTabs, ["w1:t2"]);
});

test("routes HerdrM reference actions from the Herdr-only more menu", async (t) => {
  installFakeDom(t);
  const { dock, consoleActions } = controllerHarness();

  for (const action of ["new-agent", "search", "rename-workspace", "close-agent"]) {
    const button = new FakeElement("button", { herdrJumpAction: action }).appendTo(dock);
    dock.dispatch("click", button);
    await Promise.resolve();
  }

  assert.deepEqual(consoleActions, ["new-agent", "search", "rename-workspace", "close-agent"]);
});

test("cycles visible more-menu items with Arrow, Home, and End keys", (t) => {
  installFakeDom(t);
  const { moreButton, moreMenu } = controllerHarness();
  const first = new FakeElement("button").appendTo(moreMenu);
  const hidden = new FakeElement("button").appendTo(moreMenu);
  hidden.hidden = true;
  const last = new FakeElement("button").appendTo(moreMenu);
  moreMenu.querySelectorAll = () => [first, hidden, last];

  moreButton.dispatch("keydown", moreButton, { key: "ArrowDown" });
  assert.equal(document.activeElement, first);

  moreMenu.dispatch("keydown", first, { key: "ArrowUp" });
  assert.equal(document.activeElement, last);

  moreMenu.dispatch("keydown", last, { key: "Home" });
  assert.equal(document.activeElement, first);

  moreMenu.dispatch("keydown", first, { key: "End" });
  assert.equal(document.activeElement, last);
});
