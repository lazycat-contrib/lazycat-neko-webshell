import assert from "node:assert/strict";
import test from "node:test";
import { remoteTabDetail, tabLabelPresentation } from "./tab-labels.ts";

test("shows local source context on the active tab", () => {
  assert.deepEqual(tabLabelPresentation({
    active: true,
    remote: false,
    pinned: false,
    sourceName: "Neko Webshell",
    terminalName: "Herdr",
    terminalHasText: true,
  }), {
    displayName: "Neko Webshell · Herdr",
    title: "Neko Webshell · Herdr",
    iconOnly: false,
    named: true,
  });
});

test("keeps inactive remote tabs icon-only with contextual accessibility text", () => {
  assert.deepEqual(tabLabelPresentation({
    active: false,
    remote: true,
    pinned: false,
    sourceName: "MacBook Pro",
    terminalName: "Herdr",
    terminalHasText: true,
  }), {
    displayName: "Herdr",
    title: "MacBook Pro · Herdr",
    iconOnly: true,
    named: false,
  });
});

test("shows remote source context on the active tab", () => {
  assert.deepEqual(tabLabelPresentation({
    active: true,
    remote: true,
    pinned: false,
    sourceName: "MacBook Pro",
    terminalName: "Herdr",
    terminalHasText: true,
  }), {
    displayName: "MacBook Pro · Herdr",
    title: "MacBook Pro · Herdr",
    iconOnly: false,
    named: true,
  });
});

test("does not repeat equal source and terminal names", () => {
  assert.equal(tabLabelPresentation({
    active: true,
    remote: false,
    pinned: false,
    sourceName: "Herdr",
    terminalName: "Herdr",
    terminalHasText: true,
  }).displayName, "Herdr");
});

test("resolves remote Herdr as the terminal detail", () => {
  assert.equal(
    remoteTabDetail(
      { label: "client:alice-pc" },
      { title: "shell", programKind: "herdr" },
      "Terminal 1",
    ),
    "Herdr",
  );
});
