import assert from "node:assert/strict";
import test from "node:test";

import { renderMobileKeyboardView } from "./keyboard-view.ts";

test("renders a persistent system keyboard toggle before the scrollable shortcut panels", () => {
  const html = renderMobileKeyboardView();
  const toggleIndex = html.indexOf('data-mobile-action="toggle-system-keyboard"');
  const mainPanelIndex = html.indexOf('data-mobile-panel="main"');

  assert.match(html, /class="mobile-keyboard-controls"/);
  assert.match(html, /data-mobile-action="toggle-system-keyboard"[^>]*aria-pressed="false"/);
  assert.ok(toggleIndex > 0);
  assert.ok(toggleIndex < mainPanelIndex);
});
