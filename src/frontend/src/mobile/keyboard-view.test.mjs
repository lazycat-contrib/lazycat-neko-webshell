import assert from "node:assert/strict";
import test from "node:test";

import { renderMobileKeyboardView } from "./keyboard-view.ts";

test("keeps the system keyboard toggle out of the scrollable shortcut rail", () => {
  const html = renderMobileKeyboardView();
  const pagesIndex = html.indexOf('class="mobile-keyboard-pages"');
  const toggleIndex = html.indexOf('data-mobile-action="toggle-system-keyboard"');
  const clockIndex = html.indexOf('class="mobile-shortcut-clock"');
  const controlsIndex = html.indexOf('class="mobile-keyboard-controls"');
  const mainPanelIndex = html.indexOf('data-mobile-panel="main"');
  const leftIndex = html.indexOf('data-mobile-shortcut="left"', mainPanelIndex);
  const downIndex = html.indexOf('data-mobile-shortcut="down"', mainPanelIndex);
  const upIndex = html.indexOf('data-mobile-shortcut="up"', mainPanelIndex);
  const rightIndex = html.indexOf('data-mobile-shortcut="right"', mainPanelIndex);
  const tabIndex = html.indexOf('data-mobile-shortcut="tab"', mainPanelIndex);

  assert.match(html, /class="mobile-keyboard-controls"/);
  assert.match(html, /data-mobile-action="toggle-system-keyboard"[^>]*aria-pressed="false"/);
  assert.ok(pagesIndex < toggleIndex);
  assert.ok(toggleIndex < clockIndex);
  assert.ok(clockIndex < controlsIndex);
  assert.ok(controlsIndex < mainPanelIndex);
  assert.ok(mainPanelIndex < leftIndex);
  assert.ok(leftIndex < downIndex);
  assert.ok(downIndex < upIndex);
  assert.ok(upIndex < rightIndex);
  assert.ok(rightIndex < tabIndex);
});
