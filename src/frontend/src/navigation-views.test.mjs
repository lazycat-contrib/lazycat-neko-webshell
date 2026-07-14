import assert from "node:assert/strict";
import test from "node:test";
import { renderTabsView } from "./navigation-views.ts";

test("renders a remote tab as one icon without visible title text", () => {
  const html = renderTabsView([{
    id: "remote",
    active: true,
    renaming: false,
    named: false,
    pinned: false,
    pinnedGlyph: "R",
    canMovePinnedPrevious: false,
    canMovePinnedNext: false,
    displayName: "Alice PC Herdr",
    title: "Alice PC — Herdr",
    tone: "ok",
    icon: "monitor-smartphone",
    iconOnly: true,
  }], {
    empty: "Empty",
    rename: "Rename",
    close: "Close",
    pin: "Pin",
    unpin: "Unpin",
    movePinnedPrevious: "Previous",
    movePinnedNext: "Next",
  });
  assert.match(html, /data-lucide="monitor-smartphone"/);
  assert.doesNotMatch(html, /class="tab-title">Alice PC Herdr/);
  assert.match(html, /aria-label="Alice PC — Herdr"/);
});
