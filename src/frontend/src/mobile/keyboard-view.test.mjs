import assert from "node:assert/strict";
import test from "node:test";

import { renderMobileKeyboardView } from "./keyboard-view.ts";

test("keeps quick keys and mode controls in one persistent mobile toolbar", () => {
  const html = renderMobileKeyboardView();
  const quickStart = html.indexOf('class="mobile-keyboard-quick-keys"');
  const actionStart = html.indexOf('class="mobile-keyboard-toolbar-actions"');
  const expandedStart = html.indexOf('class="mobile-expanded-keyboard"');

  assert.match(html, /id="mobileShortcuts"[^>]*data-active-page="typing" data-expanded="false"/);
  assert.ok(quickStart >= 0 && quickStart < actionStart && actionStart < expandedStart);
  for (const direction of ["up", "down", "left", "right"]) {
    const index = html.indexOf(`data-mobile-shortcut="${direction}"`, quickStart);
    assert.ok(index > quickStart && index < actionStart, `${direction} stays on the quick bar`);
  }
  for (const chord of ["ctrl-c", "ctrl-z"]) {
    const index = html.indexOf(`data-mobile-chord="${chord}"`, quickStart);
    assert.ok(index > quickStart && index < actionStart, `${chord} stays on the quick bar`);
  }
  const pasteIndex = html.indexOf('data-mobile-action="paste-clipboard"', quickStart);
  assert.ok(pasteIndex > quickStart && pasteIndex < actionStart);
  for (const modifier of ["ctrl", "alt", "shift"]) {
    const index = html.indexOf(`data-mobile-shortcut="${modifier}" data-mobile-modifier="${modifier}"`, quickStart);
    assert.ok(index > quickStart && index < actionStart, `${modifier} stays available for the system keyboard`);
  }
  for (const action of ["compose-text", "toggle-system-keyboard", "toggle-expanded-keyboard"]) {
    const index = html.indexOf(`data-mobile-action="${action}"`);
    assert.ok(index > actionStart && index < expandedStart, `${action} stays on the toolbar`);
    assert.equal(html.split(`data-mobile-action="${action}"`).length - 1, 1);
  }
  assert.match(html.slice(actionStart, expandedStart), /class="mobile-secret-file-button" data-mobile-action="secret-file"/);
  assert.match(html.slice(expandedStart), /class="mobile-secret-file-secondary" data-mobile-action="secret-file"/);
  assert.match(html, /data-mobile-action="toggle-system-keyboard"[^>]*aria-pressed="false"/);
  assert.match(html, /data-mobile-action="toggle-expanded-keyboard"[^>]*aria-expanded="false"/);
  assert.match(html, /id="mobileExpandedKeyboard" hidden/);
});

test("expanded keyboard keeps typing, function, and editable shortcut pages separate", () => {
  const html = renderMobileKeyboardView();
  assert.match(html, /data-mobile-page="typing" aria-pressed="true"/);
  assert.match(html, /data-mobile-page="function" aria-pressed="false"/);
  assert.match(html, /data-mobile-mode-tab="shortcuts"/);
  assert.match(html, /data-mobile-panel="typing"/);
  assert.match(html, /data-mobile-panel="function"[^>]*hidden/);
  assert.match(html, /data-mobile-panel="main"[^>]*hidden/);
  assert.match(html, /data-mobile-panel="phrases" hidden/);
  assert.match(html, /class="mobile-keyboard-page-tabs"/);
  assert.match(html, /class="mobile-shortcut-clock"/);
  assert.match(html, /data-mobile-shortcut="escape"/);
});
