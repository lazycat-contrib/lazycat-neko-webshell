import assert from "node:assert/strict";
import test from "node:test";

import { reactivateSystemKeyboardInput } from "./mobile/system-keyboard-focus.ts";

test("reactivates an already-focused readonly IME input for the system keyboard", () => {
  const calls = [];
  let activeElement;
  const input = {
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
