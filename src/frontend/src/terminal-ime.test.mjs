import assert from "node:assert/strict";
import test from "node:test";

import {
  deactivateSystemKeyboardInput,
  enableSystemKeyboardInput,
  focusPaneHardwareKeyboardInput,
  reactivateSystemKeyboardInput,
} from "./mobile/system-keyboard-focus.ts";
import { preparePaneImeForKeyboardEvent } from "./terminal-ime.ts";

test("keeps Windows IME composition in the terminal search input", () => {
  let stopped = false;
  const searchInput = {};
  let activeElement = searchInput;
  const pane = {
    terminalCanvas: {},
    terminalImeInput: { focus() { activeElement = pane.terminalImeInput; } },
  };
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { get activeElement() { return activeElement; } },
  });
  try {
    for (const key of ["Process", "w"]) {
      const event = {
        type: "keydown", target: searchInput, key, code: "KeyW",
        keyCode: key === "Process" ? 229 : 0, defaultPrevented: false,
        ctrlKey: false, metaKey: false, altKey: false,
        stopPropagation() { stopped = true; },
      };
      assert.equal(preparePaneImeForKeyboardEvent(pane, event), false);
    }
    assert.equal(stopped, false);
    assert.equal(activeElement, searchInput);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("routes Windows IME process keys to the textarea without sending a physical letter", () => {
  let activeElement = null;
  const canvas = {};
  const input = {
    focus() { activeElement = input; },
  };
  const pane = { terminalCanvas: canvas, terminalImeInput: input };
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { get activeElement() { return activeElement; } },
  });

  try {
    for (const key of ["Process", "Unidentified"]) {
      activeElement = null;
      let stopped = false;
      let prevented = false;
      const event = {
        type: "keydown", target: canvas, key, code: "KeyW", keyCode: key === "Process" ? 0 : 229,
        defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false,
        stopPropagation() { stopped = true; },
        preventDefault() { prevented = true; },
      };
      assert.equal(preparePaneImeForKeyboardEvent(pane, event), true);
      assert.equal(activeElement, input);
      assert.equal(stopped, true, "Restty must not encode KeyW while the IME owns it");
      assert.equal(prevented, false, "the browser must still receive the IME key");
    }
    let stopped = false;
    assert.equal(preparePaneImeForKeyboardEvent(pane, {
      type: "keyup", target: input, key: "Process", code: "KeyW", keyCode: 229,
      defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false,
      stopPropagation() { stopped = true; },
    }), true);
    assert.equal(stopped, true, "kitty key release must not send the physical letter");

    stopped = false;
    assert.equal(preparePaneImeForKeyboardEvent(pane, {
      type: "keyup", target: input, key: "w", code: "KeyW", keyCode: 0,
      defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false,
      stopPropagation() { stopped = true; },
    }), false);
    assert.equal(stopped, false);

    activeElement = canvas;
    assert.equal(preparePaneImeForKeyboardEvent(pane, {
      type: "keydown", target: canvas, key: "w", code: "KeyW", keyCode: 0,
      defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false,
      stopPropagation() { stopped = true; },
    }), true);
    assert.equal(activeElement, input);
    assert.equal(stopped, false);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("reactivates an already-focused readonly IME input for the system keyboard", () => {
  const calls = [];
  let activeElement;
  const input = {
    disabled: true,
    readOnly: true,
    blur() {
      calls.push("blur");
      activeElement = undefined;
    },
    focus() {
      calls.push("focus");
      activeElement = input;
    },
  };
  activeElement = input;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get activeElement() {
        return activeElement;
      },
    },
  });

  try {
    assert.equal(reactivateSystemKeyboardInput(input), true);
    assert.equal(input.disabled, false);
    assert.equal(input.readOnly, false);
    assert.deepEqual(calls, ["blur", "focus"]);
    assert.equal(activeElement, input);
  } finally {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

test("re-enables a mobile-disabled IME without stealing desktop focus", () => {
  let activeElement = { id: "desktop-control" };
  const input = { disabled: true, readOnly: true };
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get activeElement() {
        return activeElement;
      },
    },
  });

  try {
    enableSystemKeyboardInput(input);
    assert.equal(input.disabled, false);
    assert.equal(input.readOnly, false);
    assert.deepEqual(activeElement, { id: "desktop-control" });
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("deactivates a focused IME input so mobile shortcuts do not reopen the system keyboard", () => {
  const calls = [];
  let activeElement;
  const input = {
    disabled: false,
    readOnly: false,
    blur() {
      calls.push("blur");
      activeElement = undefined;
    },
  };
  activeElement = input;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get activeElement() {
        return activeElement;
      },
    },
  });

  try {
    assert.equal(deactivateSystemKeyboardInput(input), true);
    assert.equal(input.disabled, true);
    assert.equal(input.readOnly, true);
    assert.deepEqual(calls, ["blur"]);
    assert.equal(activeElement, undefined);
  } finally {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  }
});

test("keeps hardware focus on the canvas when Restty redirects focus to the disabled IME", () => {
  let activeElement;
  class MockHTMLElement {
    focus() {
      activeElement = this;
    }
  }
  const canvas = new MockHTMLElement();
  const input = {
    disabled: false,
    readOnly: false,
    blur() {
      if (activeElement === input) activeElement = undefined;
    },
    focus() {
      if (!input.disabled) activeElement = input;
    },
  };
  canvas.focus = () => {
    activeElement = canvas;
    input.focus();
  };
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: MockHTMLElement,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get activeElement() {
        return activeElement;
      },
    },
  });

  try {
    assert.equal(focusPaneHardwareKeyboardInput({ terminalCanvas: canvas, terminalImeInput: input }), true);
    assert.equal(input.disabled, true);
    assert.equal(input.readOnly, true);
    assert.equal(activeElement, canvas);
  } finally {
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: originalHTMLElement });
    if (originalDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});
