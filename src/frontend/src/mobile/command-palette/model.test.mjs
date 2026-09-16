import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  choicesForTab,
  isSafePaletteKey,
  keyChoices,
  MobilePaletteOperationLock,
  operationOwnsView,
  phraseChoices,
  resolveActivationTarget,
  resolveCurrentChoice,
} from "./model.ts";

function phrase(overrides = {}) {
  return {
    id: "one",
    label: "Deploy",
    text: "npm run deploy",
    useCount: 0,
    lastUsedAt: 0,
    group: "Operations",
    order: 0,
    sendEnter: false,
    ...overrides,
  };
}

function key(overrides = {}) {
  return {
    id: "key-one",
    kind: "shortcut",
    value: "escape",
    label: "Esc",
    ariaLabel: "Escape",
    width: "md",
    hidden: false,
    repeat: false,
    autoEnter: false,
    custom: false,
    ...overrides,
  };
}

test("searches phrase labels, multiline text and groups without case sensitivity", () => {
  const phrases = [
    phrase({ id: "label", label: "Restart Worker", text: "systemctl restart app", order: 2 }),
    phrase({ id: "text", label: "Logs", text: "journalctl\n--follow", order: 1 }),
    phrase({ id: "group", label: "Status", group: "Diagnostics", order: 0 }),
  ];
  assert.deepEqual(phraseChoices(phrases, "all", "WORKER").map((item) => item.phrase.id), ["label"]);
  assert.deepEqual(phraseChoices(phrases, "all", "--FOLLOW").map((item) => item.phrase.id), ["text"]);
  assert.deepEqual(phraseChoices(phrases, "all", "diagnos").map((item) => item.phrase.id), ["group"]);
});

test("keeps configured phrase order for All and uses real timestamps for Recent", () => {
  const phrases = [
    phrase({ id: "late-order", order: 9, lastUsedAt: 20 }),
    phrase({ id: "unused", order: 0, lastUsedAt: 0 }),
    phrase({ id: "recent", order: 4, lastUsedAt: 40 }),
  ];
  assert.deepEqual(phraseChoices(phrases, "all", "").map((item) => item.phrase.id), ["unused", "recent", "late-order"]);
  assert.deepEqual(phraseChoices(phrases, "recent", "").map((item) => item.phrase.id), ["recent", "late-order"]);
});

test("exposes only terminal shortcuts, chords and explicit custom text keys", () => {
  const keys = [
    key({ id: "shortcut", label: "Escape" }),
    key({ id: "chord", kind: "chord", value: "ctrl-c", label: "Ctrl+C" }),
    key({ id: "text", kind: "text", value: "git status", label: "Status", custom: true, autoEnter: true }),
    key({ id: "fake-text", kind: "text", value: "rm -rf /", label: "Fake", custom: false }),
    key({ id: "action", kind: "action", value: "close-tab", label: "Close tab" }),
    key({ id: "hidden", hidden: true }),
  ];
  assert.deepEqual(keyChoices(keys, "").map((item) => item.key.id), ["shortcut", "chord", "text"]);
  assert.deepEqual(keyChoices(keys, "GIT STATUS").map((item) => item.key.id), ["text"]);
  assert.equal(isSafePaletteKey(keys[4]), false);
});

test("does not resolve removed or changed choices against current configuration", () => {
  const shownPhrase = phraseChoices([phrase()], "all", "")[0];
  const shownKey = keyChoices([key()], "")[0];
  assert.equal(resolveCurrentChoice(shownPhrase, [], []), undefined);
  assert.equal(resolveCurrentChoice(shownPhrase, [phrase({ text: "changed" })], []), undefined);
  assert.equal(resolveCurrentChoice(shownKey, [], [key({ value: "enter" })]), undefined);
  assert.equal(resolveCurrentChoice(shownKey, [], [key({ hidden: true })]), undefined);
  assert.equal(resolveCurrentChoice(shownPhrase, [phrase()], []).kind, "phrase");
  assert.equal(resolveCurrentChoice(shownKey, [], [key()]).kind, "key");
});

test("preserves stable custom key identity and explicit autoEnter metadata", () => {
  const custom = key({ id: "custom-42", kind: "text", value: "echo ready", custom: true, autoEnter: true });
  const choice = choicesForTab([], [custom], "keys", "")[0];
  assert.equal(choice.id, "key:custom-42");
  assert.equal(choice.key.autoEnter, true);
  assert.notEqual(choice.key, custom);
});

test("accepts only the exact captured target approved by the parent", () => {
  const captured = { key: "pane-a", generation: 3 };
  const replacement = { key: "pane-a", generation: 4 };
  assert.equal(resolveActivationTarget(captured, (candidate) => candidate === captured), captured);
  assert.equal(resolveActivationTarget(captured, (candidate) => candidate === replacement), undefined);
  assert.equal(resolveActivationTarget(undefined, () => true), undefined);
});

test("keeps a pending activation locked across close and reopen generations", () => {
  const lock = new MobilePaletteOperationLock();
  const target = { key: "pane-a" };
  const pending = lock.begin();
  assert.ok(pending);
  assert.equal(lock.busy, true);

  const reopenedGeneration = 4;
  assert.equal(lock.begin(), undefined);
  assert.equal(operationOwnsView(3, reopenedGeneration, target, target), false);
  assert.equal(lock.complete(pending), true);
  assert.equal(lock.busy, false);

  const next = lock.begin();
  assert.ok(next);
  assert.equal(operationOwnsView(reopenedGeneration, reopenedGeneration, target, target), true);
  assert.equal(lock.complete(pending), false);
  assert.equal(lock.busy, true);
  assert.equal(lock.complete(next), true);
});

test("renders untrusted labels and previews through DOM text APIs only", async () => {
  const malicious = '<img src=x onerror="globalThis.pwned=true">\n<script>alert(1)</script>';
  const choice = phraseChoices([phrase({ label: malicious, text: malicious })], "all", "")[0];
  assert.equal(choice.phrase.label, malicious);
  assert.equal(choice.phrase.text, malicious);
  const source = await readFile(new URL("./view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/);
  assert.match(source, /node\.textContent = text/);
});
