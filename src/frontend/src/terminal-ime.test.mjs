import assert from "node:assert/strict";
import test from "node:test";

import {
  deactivateSystemKeyboardInput,
  enableSystemKeyboardInput,
  focusPaneHardwareKeyboardInput,
  reactivateSystemKeyboardInput,
} from "./mobile/system-keyboard-focus.ts";

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
