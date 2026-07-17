import assert from "node:assert/strict";
import test from "node:test";

import {
  nativePaneContextMenuItems,
  paneMenuActionSupported,
} from "./pane-menu-actions.ts";

function pane(sessionBackend = "native") {
  return { sessionBackend };
}

function tab(...panes) {
  return { panes };
}

test("uses translated labels in Restty native context menus", () => {
  const targetPane = pane();
  const targetTab = tab(targetPane);
  const items = nativePaneContextMenuItems({
    pane: targetPane,
    tab: targetTab,
    visiblePaneCount: () => 1,
    translate: (key) => `translated:${key}`,
    runAction: () => undefined,
  });

  const labels = items
    .filter((item) => item !== "separator")
    .map((item) => item.label);
  assert.ok(labels.includes("translated:action.splitUp"));
  assert.ok(labels.includes("translated:action.copySelection"));
  assert.ok(labels.includes("translated:action.closeActiveSession"));
  assert.equal(labels.some((label) => label === "Split up"), false);
});

test("keeps Herdr context menu actions within Herdr capabilities", () => {
  const herdrPane = pane("herdr");
  const herdrTab = tab(herdrPane);
  const visiblePaneCount = () => 1;

  assert.equal(paneMenuActionSupported("split-right", herdrPane, herdrTab, visiblePaneCount), true);
  assert.equal(paneMenuActionSupported("split-up", herdrPane, herdrTab, visiblePaneCount), false);
  assert.equal(paneMenuActionSupported("resize-left", herdrPane, herdrTab, visiblePaneCount), true);
  assert.equal(paneMenuActionSupported("promote-session-to-tab", herdrPane, herdrTab, visiblePaneCount), false);
});

test("keeps zellij context menu actions within zellij capabilities", () => {
  const zellijPane = pane("zellij");
  const zellijTab = tab(zellijPane);
  const visiblePaneCount = () => 1;

  assert.equal(paneMenuActionSupported("split-down", zellijPane, zellijTab, visiblePaneCount), true);
  assert.equal(paneMenuActionSupported("split-left", zellijPane, zellijTab, visiblePaneCount), false);
  assert.equal(paneMenuActionSupported("resize-right", zellijPane, zellijTab, visiblePaneCount), false);
});
