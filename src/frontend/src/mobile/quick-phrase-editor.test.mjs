import assert from "node:assert/strict";
import test from "node:test";

import { createMobileQuickPhraseEditor } from "./quick-phrase-editor.ts";
import { normalizeMobileQuickPhrases } from "./quick-input.ts";

function editorElements() {
  return {
    mobileQuickPhraseList: { innerHTML: "" },
    mobileQuickPhraseSave: { textContent: "" },
    mobileQuickPhraseCancel: { hidden: true },
    mobileQuickPhraseLabel: { value: "" },
    mobileQuickPhraseGroup: { value: "" },
    mobileQuickPhraseText: { value: "", focus() {} },
    mobileQuickPhraseSendEnter: { checked: false },
    mobileQuickPhraseStatus: { textContent: "", dataset: {} },
  };
}

test("preserves manual order when editing a quick phrase", () => {
  const phrases = normalizeMobileQuickPhrases([
    { id: "first", label: "First", text: "one", order: 0 },
    { id: "second", label: "Second", text: "two", order: 1 },
  ]);
  const elements = editorElements();
  const editor = createMobileQuickPhraseEditor(elements);
  assert.equal(editor.beginEdit("first", phrases, (key) => key), true);
  elements.mobileQuickPhraseLabel.value = "Updated";
  const result = editor.save(phrases);
  assert.equal(result.ok, true);
  assert.deepEqual(result.phrases.map((phrase) => [phrase.id, phrase.order]), [["first", 0], ["second", 1]]);
});
