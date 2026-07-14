import assert from "node:assert/strict";
import test from "node:test";
import { renderTabsView } from "./navigation-views.ts";

const labels = {
  empty: "Empty",
  rename: "Rename",
  close: "Close",
  pin: "Pin",
  unpin: "Unpin",
  movePinnedPrevious: "Previous",
  movePinnedNext: "Next",
};

test("renders an inactive remote tab as one icon without visible title text", () => {
  const html = renderTabsView([{
    id: "remote",
    active: false,
    renaming: false,
    named: false,
    pinned: false,
    pinnedGlyph: "R",
    canMovePinnedPrevious: false,
    canMovePinnedNext: false,
    displayName: "Herdr",
    title: "Alice PC · Herdr",
    tone: "ok",
    icon: "monitor-smartphone",
    iconOnly: true,
  }], labels);
  assert.match(html, /data-lucide="monitor-smartphone"/);
  assert.doesNotMatch(html, /class="tab-title">Herdr/);
  assert.match(html, /aria-label="Alice PC · Herdr"/);
});

test("renders an active remote tab with its icon and contextual title", () => {
  const html = renderTabsView([{
    id: "remote",
    active: true,
    renaming: false,
    named: true,
    pinned: false,
    pinnedGlyph: "R",
    canMovePinnedPrevious: false,
    canMovePinnedNext: false,
    displayName: "MacBook Pro · Herdr",
    title: "MacBook Pro · Herdr",
    tone: "ok",
    icon: "monitor-smartphone",
    iconOnly: false,
  }], labels);
  assert.match(html, /data-lucide="monitor-smartphone"/);
  assert.match(html, /class="tab-title">MacBook Pro · Herdr<\/span>/);
  assert.match(html, /aria-label="MacBook Pro · Herdr"/);
});
