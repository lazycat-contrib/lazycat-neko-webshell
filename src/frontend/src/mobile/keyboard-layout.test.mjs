import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MOBILE_KEY_TEXT,
  mobileKeyboardPresetLayout,
  moveMobileKeyboardKey,
  moveMobileKeyboardKeyToIndex,
  normalizeMobileKeyboardLayout,
  normalizeMobileKeyboardPreset,
  resolveMobileKeyboardLayout,
  updateMobileKeyboardKey,
  decodeMobileKeyboardText,
} from "./keyboard-layout.ts";
import { renderMobileKeyboardKey } from "./keyboard-layout-view.ts";
import { renderMobileKeyboardLayoutSettingsView } from "./settings/keyboard-layout-view.ts";

test("normalizes mobile keyboard layouts through the shortcut and action allowlists", () => {
  const layout = normalizeMobileKeyboardLayout({
    pages: [{
      id: "main",
      keys: [
        { id: "ok", kind: "action", value: "workspace-overview", label: "Overview", width: "lg" },
        { id: "bad-action", kind: "action", value: "pane.executeJavascript", label: "Bad" },
        { id: "bad-shortcut", kind: "shortcut", value: "unknown-key", label: "Bad" },
        { id: "text", kind: "text", value: "x".repeat(MAX_MOBILE_KEY_TEXT + 20), label: " Long label ", autoEnter: true },
      ],
    }],
  });

  const main = layout.pages.find((page) => page.id === "main");
  assert.deepEqual(main?.keys.map((key) => key.id), ["ok", "text"]);
  assert.equal(main?.keys[0]?.width, "lg");
  assert.equal(main?.keys[1]?.value.length, MAX_MOBILE_KEY_TEXT);
  assert.equal(main?.keys[1]?.autoEnter, true);
  assert.equal(main?.keys[1]?.repeat, false);
});

test("decodes documented terminal escape notation", () => {
  assert.equal(decodeMobileKeyboardText("\\x1b[A\\r"), "\x1b[A\r");
  assert.equal(decodeMobileKeyboardText("\\e[Z"), "\x1b[Z");
});

test("encodes terminal controls safely in custom key data attributes", () => {
  const layout = normalizeMobileKeyboardLayout({ pages: [{ id: "main", keys: [{ id: "text", kind: "text", value: "\x1b[A\r", label: "Up" }] }] });
  const html = renderMobileKeyboardKey(layout.pages[0].keys[0]);
  assert.match(html, /data-mobile-text="&#27;\[A&#13;"/);
  assert.doesNotMatch(html, /data-mobile-text="\x1b/);
});

test("built-in presets are returned as independent layouts", () => {
  const first = mobileKeyboardPresetLayout("operations");
  const second = mobileKeyboardPresetLayout("operations");
  assert.notEqual(first, second);
  first.pages[0].keys[0].hidden = true;
  assert.equal(second.pages[0].keys[0].hidden, false);
  assert.ok(second.pages.some((page) => page.keys.some((key) => key.value === "maximize-pane")));
  assert.ok(second.pages.some((page) => page.keys.some((key) => key.value === "workspace-overview")));
});

test("round-trips every built-in preset through the persisted layout normalizer", () => {
  for (const preset of ["default", "operations", "editor"]) {
    const layout = mobileKeyboardPresetLayout(preset);
    assert.deepEqual(normalizeMobileKeyboardLayout(layout), layout);
  }
});

test("keeps the legacy shortcut layout until the user opts into customization", () => {
  assert.equal(normalizeMobileKeyboardPreset(undefined), "default");
  const expectedIds = {
    main: ["main-ctrl", "main-alt", "main-shift", "main-left", "main-down", "main-up", "main-right", "main-tab", "main-enter", "main-copy", "main-paste", "main-menu", "main-ctrl-e", "main-ctrl-c", "main-swap", "main-shift-tab", "main-tilde", "main-slash", "main-hyphen", "main-dollar", "main-escape"],
    ops: ["ops-prev-tab", "ops-next-tab", "ops-new-tab", "ops-close-tab", "ops-prev-pane", "ops-next-pane", "ops-split-right", "ops-split-down", "ops-copy", "ops-paste", "ops-font-up", "ops-font-down"],
    nav: ["nav-home", "nav-end", "nav-page-up", "nav-page-down", "nav-insert", "nav-delete", "nav-backspace", "nav-left", "nav-down", "nav-up", "nav-right"],
    fn: Array.from({ length: 12 }, (_, index) => `fn-${index + 1}`),
    sym: Array.from({ length: 18 }, (_, index) => `sym-${index}`),
  };
  const legacy = resolveMobileKeyboardLayout("default", { pages: [] });
  assert.deepEqual(Object.fromEntries(legacy.pages.map((page) => [page.id, page.keys.map((key) => key.id)])), expectedIds);
  assert.ok(legacy.pages.every((page) => page.keys.every((key) => key.width === "md")));
  assert.ok(!legacy.pages.some((page) => page.keys.some((key) => key.value === "maximize-pane" || key.value === "workspace-overview")));

  const recovered = resolveMobileKeyboardLayout("custom", { pages: [] });
  assert.deepEqual(recovered.pages.map((page) => page.keys.map((key) => key.id)), legacy.pages.map((page) => page.keys.map((key) => key.id)));

  const custom = normalizeMobileKeyboardLayout({ pages: [{ id: "main", keys: [{ id: "mine", kind: "text", value: "ls", label: "List" }] }] });
  assert.equal(resolveMobileKeyboardLayout("custom", custom).pages[0].keys[0]?.id, "mine");
});

test("moves and updates keys without mutating the source layout", () => {
  const layout = mobileKeyboardPresetLayout("default");
  const page = layout.pages.find((item) => item.id === "main");
  assert.ok(page && page.keys.length > 2);
  const moved = moveMobileKeyboardKey(layout, "main", page.keys[1].id, -1);
  assert.equal(moved.pages.find((item) => item.id === "main")?.keys[0].id, page.keys[1].id);
  assert.notEqual(moved, layout);

  const updated = updateMobileKeyboardKey(layout, "main", page.keys[0].id, { hidden: true, width: "lg" });
  const key = updated.pages.find((item) => item.id === "main")?.keys[0];
  assert.equal(key?.hidden, true);
  assert.equal(key?.width, "lg");
});

test("moves a key to an exact visual grid position without mutating the source layout", () => {
  const layout = mobileKeyboardPresetLayout("default");
  const page = layout.pages.find((item) => item.id === "main");
  assert.ok(page);
  const keyId = page.keys[1].id;
  const moved = moveMobileKeyboardKeyToIndex(layout, "main", keyId, 6);
  assert.equal(moved.pages.find((item) => item.id === "main")?.keys[6]?.id, keyId);
  assert.equal(layout.pages.find((item) => item.id === "main")?.keys[1]?.id, keyId);
});

test("keeps the settings editor tabs isolated from the live shortcut toolbar", () => {
  const html = renderMobileKeyboardLayoutSettingsView();
  assert.match(html, /mobile-keyboard-editor-tabs/);
  assert.doesNotMatch(html, /class="mobile-keyboard-page-tabs"/);
  assert.match(html, /role="tabpanel"/);
});
