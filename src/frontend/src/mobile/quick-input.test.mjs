import assert from "node:assert/strict";
import test from "node:test";

import {
  makeMobileQuickPhrase,
  moveMobileQuickPhrase,
  normalizeMobileQuickPhrases,
  sortedMobileQuickPhrases,
} from "./quick-input.ts";

test("migrates legacy phrases to explicit manual order", () => {
  const phrases = normalizeMobileQuickPhrases([
    { id: "one", label: "One", text: "echo one", useCount: 9, lastUsedAt: 8 },
    { id: "two", label: "Two", text: "echo two", group: " deploy ", order: 0, sendEnter: true },
  ]);
  assert.deepEqual(phrases.map(({ group, order, sendEnter }) => ({ group, order, sendEnter })), [
    { group: "", order: 0, sendEnter: false },
    { group: "deploy", order: 1, sendEnter: true },
  ]);
  assert.deepEqual(sortedMobileQuickPhrases(phrases).map((phrase) => phrase.id), ["one", "two"]);
});

test("moves phrases while preserving their data", () => {
  const phrases = normalizeMobileQuickPhrases([
    { id: "one", label: "One", text: "one" },
    { id: "two", label: "Two", text: "two" },
  ]);
  const moved = moveMobileQuickPhrase(phrases, "two", -1);
  assert.deepEqual(moved.map((phrase) => [phrase.id, phrase.order]), [["two", 0], ["one", 1]]);
  assert.deepEqual(phrases.map((phrase) => phrase.id), ["one", "two"]);
});

test("creates grouped phrases with Enter disabled unless selected", () => {
  const phrase = makeMobileQuickPhrase({ label: "Deploy", text: "./deploy", group: "ops", sendEnter: true });
  assert.equal(phrase.group, "ops");
  assert.equal(phrase.sendEnter, true);
  assert.equal(phrase.order, 0);
});
