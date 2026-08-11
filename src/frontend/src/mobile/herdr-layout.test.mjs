import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
const mobileHerdrStart = css.indexOf(".herdr-dock:has(.herdr-workspace-menu:not([hidden]))");
const mobileHerdrEnd = css.indexOf(
  "@media (max-width: 900px) and (orientation: landscape) and (pointer: coarse)",
  mobileHerdrStart,
);

assert.notEqual(mobileHerdrStart, -1, "mobile Herdr styles should exist");
assert.notEqual(mobileHerdrEnd, -1, "mobile Herdr styles should have a bounded section");

const mobileHerdrCss = css.slice(mobileHerdrStart, mobileHerdrEnd);

function ruleBody(selector) {
  const start = mobileHerdrCss.indexOf(`\n  ${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const bodyStart = mobileHerdrCss.indexOf("{", start) + 1;
  const end = mobileHerdrCss.indexOf("}", bodyStart);
  return mobileHerdrCss.slice(bodyStart, end);
}

test("mobile Herdr switcher reserves the full jump-button hit target", () => {
  const body = ruleBody(".herdr-workspace-switcher");

  assert.match(body, /flex:\s*0 0 44px;/);
  assert.match(body, /width:\s*44px;/);
});

test("mobile Herdr targets own a bounded horizontal pan rail", () => {
  const body = ruleBody(".herdr-current-targets");

  assert.match(body, /min-width:\s*0;/);
  assert.match(body, /overflow-x:\s*auto;/);
  assert.match(body, /overflow-y:\s*hidden;/);
  assert.match(body, /overscroll-behavior-inline:\s*contain;/);
  assert.match(body, /touch-action:\s*pan-x;/);
});

test("an open mobile Herdr sheet takes pointer ownership from dock siblings", () => {
  const openDockSelector = ".herdr-dock:has(.herdr-workspace-menu:not([hidden]))";
  const switcherBody = ruleBody(`${openDockSelector} > .herdr-workspace-switcher`);
  const targetsBody = ruleBody(`${openDockSelector} > .herdr-current-targets`);

  assert.match(switcherBody, /z-index:\s*1;/);
  assert.match(targetsBody, /pointer-events:\s*none;/);
});
