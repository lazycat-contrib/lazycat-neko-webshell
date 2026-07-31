import assert from "node:assert/strict";
import test from "node:test";

import { renderHerdrJumpShell } from "./herdr-jump-shell.ts";

test("renders three shared icon actions outside the Herdr jump panel", () => {
  const shell = renderHerdrJumpShell();
  const newTab = shell.indexOf('id="herdrNewTab"');
  const newWorkspace = shell.indexOf('id="herdrNewWorkspace"');
  const more = shell.indexOf('id="herdrMoreButton"');
  const moreMenu = shell.slice(shell.indexOf('id="herdrMoreMenu"'));

  assert.ok(newTab > 0);
  assert.ok(newWorkspace > newTab);
  assert.ok(more > newWorkspace);
  assert.match(shell.slice(newTab, newWorkspace), /data-lucide="square-plus"/);
  assert.match(shell.slice(newWorkspace, more), /data-icon="layers-plus"/);
  assert.doesNotMatch(moreMenu, /data-herdr-jump-action="create-(?:tab|workspace)"/);
  assert.doesNotMatch(shell, /herdr-mobile-jump-actions/);
});
