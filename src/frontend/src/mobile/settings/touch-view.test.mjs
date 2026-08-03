import assert from "node:assert/strict";
import test from "node:test";

import { renderMobileTouchSettingsView } from "./touch-view.ts";

test("renders the opt-in system keyboard prevention setting in the mobile touch group", () => {
  const html = renderMobileTouchSettingsView();
  assert.match(html, /id="preventMobileKeyboardAutoOpen"/);
  assert.match(html, /data-i18n="setting\.preventMobileKeyboardAutoOpen"/);
  assert.match(html, /data-i18n="setting\.preventMobileKeyboardAutoOpenHelp"/);
});
