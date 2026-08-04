import assert from "node:assert/strict";
import test from "node:test";

import {
  forwardPaneContextMenuToRestty,
  hideResttyPaneContextMenus,
  interceptTerminalContextMenuPointer,
  openResttyPaneContextMenu,
} from "./restty-context-menu.ts";

class FakeEvent {
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

function fixture({ coarse = true, sessionBackend = "webshell" } = {}) {
  let dispatched;
  let hideCount = 0;
  const ownerWindow = {
    innerHeight: 800,
    MouseEvent: FakeEvent,
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
    pane: { sessionBackend, term: { restty } },
    dispatched: () => dispatched,
    hideCount: () => hideCount,
  };
}

test("opens the Restty menu on its active pane", () => {
  const target = fixture();

  assert.equal(openResttyPaneContextMenu(target.pane), true);
  assert.equal(target.dispatched().type, "contextmenu");
  assert.equal(target.dispatched().bubbles, true);
  assert.equal(target.dispatched().cancelable, true);
  assert.equal(target.dispatched().clientX, 170);
  assert.equal(target.dispatched().clientY, 688);
});

test("stops desktop right-button pointer events before any terminal canvas", () => {
  const target = fixture({ coarse: false, sessionBackend: "herdr" });
  const pointer = new FakeEvent("pointerdown", {
    cancelable: true,
    pointerType: "mouse",
    button: 2,
  });

  assert.equal(interceptTerminalContextMenuPointer(target.pane, pointer), true);
  assert.equal(pointer.propagationStopped, true);
  assert.equal(pointer.defaultPrevented, false);

  const leftClick = new FakeEvent("pointerdown", { pointerType: "mouse", button: 0 });
  assert.equal(interceptTerminalContextMenuPointer(target.pane, leftClick), false);
  assert.equal(leftClick.propagationStopped, false);

  const webshell = fixture({ coarse: false, sessionBackend: "webshell" });
  const rightClick = new FakeEvent("pointerdown", { pointerType: "mouse", button: 2 });
  assert.equal(interceptTerminalContextMenuPointer(webshell.pane, rightClick), true);
  assert.equal(rightClick.propagationStopped, true);
});

test("forwards context menus from every terminal backend into the Restty menu", () => {
  const herdr = fixture({ coarse: false, sessionBackend: "herdr" });
  const herdrEvent = new FakeEvent("contextmenu", {
    cancelable: true,
    clientX: 84,
    clientY: 126,
    target: {},
  });
  assert.equal(forwardPaneContextMenuToRestty(herdr.pane, herdrEvent), true);
  assert.equal(herdrEvent.defaultPrevented, true);
  assert.equal(herdrEvent.propagationStopped, true);
  assert.equal(herdr.dispatched().clientX, 84);
  assert.equal(herdr.dispatched().clientY, 126);

  const touch = fixture({ coarse: true, sessionBackend: "webshell" });
  const touchEvent = new FakeEvent("contextmenu", {
    cancelable: true,
    clientX: 30,
    clientY: 40,
    target: {},
  });
  assert.equal(forwardPaneContextMenuToRestty(touch.pane, touchEvent), true);

  const desktop = fixture({ coarse: false, sessionBackend: "webshell" });
  const desktopEvent = new FakeEvent("contextmenu", {
    cancelable: true,
    clientX: 30,
    clientY: 40,
    target: {},
  });
  assert.equal(forwardPaneContextMenuToRestty(desktop.pane, desktopEvent), true);
  assert.equal(desktopEvent.defaultPrevented, true);
  assert.equal(desktop.dispatched().clientX, 30);
  assert.equal(desktop.dispatched().clientY, 40);
});

test("hides menus owned by every Restty terminal", () => {
  const first = fixture();
  const second = fixture();

  hideResttyPaneContextMenus([first.pane, second.pane]);

  assert.equal(first.hideCount(), 1);
  assert.equal(second.hideCount(), 1);
});
