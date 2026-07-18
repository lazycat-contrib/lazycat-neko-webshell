import assert from "node:assert/strict";
import test from "node:test";

import {
  forwardTouchContextMenuToRestty,
  hideResttyPaneContextMenus,
  openResttyPaneContextMenu,
} from "./restty-context-menu.ts";

class FakeMouseEvent {
  defaultPrevented = false;
  propagationStopped = false;

  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

function fixture({ coarse = true } = {}) {
  let dispatched;
  let hideCount = 0;
  const ownerWindow = {
    innerHeight: 800,
    MouseEvent: FakeMouseEvent,
    matchMedia: () => ({ matches: coarse }),
  };
  const container = {
    ownerDocument: { defaultView: ownerWindow },
    getBoundingClientRect: () => ({ left: 20, width: 300, bottom: 700 }),
    dispatchEvent: (event) => {
      dispatched = event;
      event.preventDefault();
      return false;
    },
  };
  const restty = {
    getActivePane: () => ({ container }),
    hideContextMenu: () => {
      hideCount += 1;
    },
  };
  return {
    container,
    pane: { term: { restty } },
    dispatched: () => dispatched,
    hideCount: () => hideCount,
  };
}

test("opens the Restty native menu on its active pane", () => {
  const target = fixture();

  assert.equal(openResttyPaneContextMenu(target.pane), true);
  assert.equal(target.dispatched().type, "contextmenu");
  assert.equal(target.dispatched().bubbles, true);
  assert.equal(target.dispatched().cancelable, true);
  assert.equal(target.dispatched().clientX, 170);
  assert.equal(target.dispatched().clientY, 688);
});

test("forwards touch context menus without intercepting desktop context menus", () => {
  const touchTarget = fixture();
  const touchEvent = new FakeMouseEvent("contextmenu", {
    cancelable: true,
    clientX: 84,
    clientY: 126,
    target: {},
  });

  assert.equal(forwardTouchContextMenuToRestty(touchTarget.pane, touchEvent), true);
  assert.equal(touchEvent.defaultPrevented, true);
  assert.equal(touchEvent.propagationStopped, true);
  assert.equal(touchTarget.dispatched().clientX, 84);
  assert.equal(touchTarget.dispatched().clientY, 126);

  const desktopTarget = fixture({ coarse: false });
  const desktopEvent = new FakeMouseEvent("contextmenu", {
    cancelable: true,
    clientX: 30,
    clientY: 40,
    target: {},
  });
  assert.equal(forwardTouchContextMenuToRestty(desktopTarget.pane, desktopEvent), false);
  assert.equal(desktopEvent.defaultPrevented, false);
  assert.equal(desktopTarget.dispatched(), undefined);
});

test("hides native menus owned by every Restty terminal", () => {
  const first = fixture();
  const second = fixture();

  hideResttyPaneContextMenus([first.pane, second.pane]);

  assert.equal(first.hideCount(), 1);
  assert.equal(second.hideCount(), 1);
});
