import assert from "node:assert/strict";
import test from "node:test";

import { encodeMobileShortcutKeyInput } from "../keyboard.ts";
import { renderMobileVirtualKeyboardPanel, renderMobileVirtualKeyboardPanels } from "./virtual-keyboard.ts";

test("renders two independent virtual keyboard pages with routable keys", () => {
  const html = renderMobileVirtualKeyboardPanels();
  assert.equal(html.match(/data-mobile-panel="(?:typing|function)"/g)?.length, 2);
  assert.match(html, /data-mobile-panel="typing"[^>]*role="group"/);
  assert.match(html, /data-mobile-panel="function"[^>]*hidden/);
  assert.equal(html.match(/data-mobile-virtual-row=/g)?.length, 11);

  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(buttons.length >= 70);
  for (const tag of buttons) {
    assert.match(tag, /type="button"/);
    assert.match(tag, /class="mobile-virtual-key"/);
    assert.match(tag, /aria-label="[^"]+"/);
    assert.equal((tag.match(/data-mobile-(?:shortcut|text|chord)=/g) ?? []).length, 1);
    const key = tag.match(/data-mobile-shortcut="([^"]*)"/)?.[1]?.replaceAll("&#039;", "'");
    if (key && !["ctrl", "alt", "shift"].includes(key)) {
      assert.notEqual(encodeMobileShortcutKeyInput(key), undefined, `unsupported virtual key: ${key}`);
    }
    const chord = tag.match(/data-mobile-chord="([^"]+)"/)?.[1];
    if (chord) assert.equal(chord, "shift-tab", `unsupported chord: ${chord}`);
  }
});

test("typing page provides a complete QWERTY and terminal control layout", () => {
  const html = renderMobileVirtualKeyboardPanel("typing");
  assert.equal(html.match(/data-mobile-virtual-row=/g)?.length, 6);
  for (const letter of "qwertyuiopasdfghjklzxcvbnm") {
    assert.match(html, new RegExp(`data-mobile-shortcut="${letter}"`));
  }
  for (const digit of "1234567890") {
    assert.match(html, new RegExp(`data-mobile-shortcut="${digit}"`));
  }
  for (const control of ["escape", "shift", "ctrl", "alt", "tab", "enter", "backspace", "left", "up", "down", "right"]) {
    assert.match(html, new RegExp(`data-mobile-shortcut="${control}"`));
  }
  assert.match(html, /data-mobile-shortcut=" " aria-label="Space"/);
  assert.match(html, /data-mobile-shortcut="\\" aria-label="Backslash"/);
  assert.match(html, /data-mobile-shortcut="&#039;" aria-label="Apostrophe"/);
  assert.match(html, /data-mobile-modifier="shift" aria-pressed="false"/);
});

test("function page exposes supported function and navigation keys", () => {
  const html = renderMobileVirtualKeyboardPanel("function");
  assert.equal(html.match(/data-mobile-virtual-row=/g)?.length, 5);
  for (let index = 1; index <= 12; index += 1) {
    assert.match(html, new RegExp(`data-mobile-shortcut="f${index}"`));
  }
  for (const key of ["escape", "tab", "home", "end", "pageUp", "pageDown", "insert", "delete", "left", "up", "down", "right"]) {
    assert.match(html, new RegExp(`data-mobile-shortcut="${key}"`));
  }
  assert.match(html, /data-mobile-chord="shift-tab"/);
  assert.doesNotMatch(html, /PrtScr|ScrLk|Pause/);
});

test("sticky Shift changes printable keys on the expanded keyboard", () => {
  assert.equal(encodeMobileShortcutKeyInput("q", { shift: true }), "Q");
  assert.equal(encodeMobileShortcutKeyInput("1", { shift: true }), "!");
  assert.equal(encodeMobileShortcutKeyInput("/", { shift: true }), "?");
  assert.equal(encodeMobileShortcutKeyInput("q", { ctrl: true, shift: true }), "\x11");
});
