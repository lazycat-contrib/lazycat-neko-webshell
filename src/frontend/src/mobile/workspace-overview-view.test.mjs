import assert from "node:assert/strict";
import test from "node:test";

import { renderMobileWorkspaceOverview, renderMobileWorkspaceOverviewShell } from "./workspace-overview-view.ts";

test("renders active tabs and panes with escaped labels", () => {
  const html = renderMobileWorkspaceOverview([{
    id: "tab-one",
    label: "Build <main>",
    detail: "device-a",
    active: true,
    panes: [{ id: "pane-one", label: "Herdr & Agent", detail: "Herdr", backend: "herdr", active: true }],
  }], { empty: "Empty", active: "Active" });
  assert.match(html, /aria-current="page"/);
  assert.match(html, /Build &lt;main&gt;/);
  assert.match(html, /Herdr &amp; Agent/);
  assert.doesNotMatch(html, /Build <main>/);
});

test("renders an actionable empty state", () => {
  assert.match(renderMobileWorkspaceOverview([], { empty: "No terminals", active: "Active" }), /No terminals/);
});

test("keeps the clickable backdrop out of the dialog focus order", () => {
  const html = renderMobileWorkspaceOverviewShell();
  assert.match(html, /mobile-workspace-overview-backdrop[^>]*tabindex="-1"[^>]*aria-hidden="true"/);
  assert.match(html, /mobile-workspace-overview-sheet[^>]*role="dialog"[^>]*aria-modal="true"/);
});
