import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";

export async function runMobileLayoutScenario() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const artifactDirectory = resolve(root, "tests-auto/artifacts/mobile-layout", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  await mkdir(artifactDirectory, { recursive: true });
  const server = await createServer({ configFile: false, root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  const browser = createBrowserDriver({ session: uniqueBrowserSession("mobile-layout"), headed: true });
  const state = () => browser.evaluate("window.layoutFixture.state()");
  const click = (selector) => browser.command(["click", selector]);
  const fill = (selector, value) => browser.command(["fill", selector, value]);
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    await browser.open(`http://127.0.0.1:${port}/tests-auto/mobile-layout/index.html`);
    await browser.command(["set", "viewport", "375", "812"]);
    await browser.waitFor("window.layoutFixture?.ready");
    const baseline = await state();
    await click('[data-mobile-key-move="main-ctrl"][data-direction="1"]');
    assert.equal((await state()).layout.pages[0].keys[1].id, "main-ctrl");
    assert.equal(await browser.evaluate('document.activeElement?.dataset.mobileKeyMove'), "main-ctrl");
    await click("[data-mobile-layout-undo]");
    assert.deepEqual((await state()).layout, baseline.layout);
    assert.equal((await state()).preset, "default");
    await click('[data-mobile-key-visibility="main-ctrl"]');
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-mobile-layout-preview] button").length'), baseline.layout.pages[0].keys.length - 1);
    await click("[data-mobile-layout-undo]");
    // Trusted pointer drag: dropping on the next key must actually move one place.
    await browser.command(["scroll", "down", "550"]);
    await browser.evaluate('document.querySelector("[data-mobile-layout-key=main-ctrl]").scrollIntoView({block:"start"})');
    const points = await browser.evaluate(`(() => { const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }; return [rect('[data-mobile-layout-key="main-ctrl"] .mobile-keyboard-drag-handle'),rect('[data-mobile-layout-key="main-alt"]')]; })()`);
    await browser.dispatchTouch([{ type: "touchStart", touchPoints: [{ ...points[0], id: 1 }], delayMs: 80 }, { type: "touchMove", touchPoints: [{ ...points[1], id: 1 }], delayMs: 80 }, { type: "touchEnd", touchPoints: [] }]);
    assert.equal((await state()).layout.pages[0].keys[1].id, "main-ctrl");
    await click("[data-mobile-layout-undo]");
    await click('[data-mobile-layout-page-tab="sym"]');
    await click("[data-mobile-key-editor-title]");
    const beforeInvalid = await state();
    await fill("[data-mobile-key-text]", "x".repeat(257));
    await click("[data-mobile-key-add]");
    assert.deepEqual(await state(), beforeInvalid);
    assert.equal(await browser.evaluate('document.querySelector("[data-mobile-key-text]").value.length'), 257);
    assert.ok(await browser.evaluate('document.querySelector("[data-mobile-layout-status]").textContent.includes("256")'));
    await fill("[data-mobile-key-label]", "My command");
    await fill("[data-mobile-key-text]", String.raw`printf '%s\\n' hello`);
    await click("[data-mobile-key-add]");
    const added = (await state()).layout.pages.find((page) => page.id === "sym").keys.at(-1);
    await click(`[data-mobile-key-edit="${added.id}"]`);
    await fill("[data-mobile-key-label]", "Renamed");
    await click("[data-mobile-key-add]");
    const edited = (await state()).layout.pages.find((page) => page.id === "sym").keys.at(-1);
    assert.equal(edited.id, added.id);
    assert.equal(edited.label, "Renamed");
    assert.equal(edited.value, added.value);
    await click(`[data-mobile-key-remove="${added.id}"]`);
    await click("[data-mobile-layout-undo]");
    assert.deepEqual((await state()).layout.pages.find((page) => page.id === "sym").keys.at(-1), edited);
    await click("[data-mobile-layout-reset]");
    assert.equal((await state()).preset, "default");
    await click("[data-mobile-layout-undo]");
    assert.equal((await state()).layout.pages.find((page) => page.id === "sym").keys.at(-1).id, added.id);
    for (const [width, locale] of [[375, "en"], [375, "zh-CN"], [1024, "en"]]) {
      await browser.navigate(`http://127.0.0.1:${port}/tests-auto/mobile-layout/index.html?locale=${locale}`);
      await browser.command(["set", "viewport", String(width), "812"]);
      await browser.waitFor("window.layoutFixture?.ready");
      const layoutCheck = await browser.evaluate(`({ width: innerWidth, scroll: document.documentElement.scrollWidth, undersized: [...document.querySelectorAll('.mobile-keyboard-key-row button, .mobile-keyboard-key-row select')].filter(el => {const r=el.getBoundingClientRect();return r.width<44||r.height<44}).length })`);
      assert.ok(layoutCheck.scroll <= layoutCheck.width, JSON.stringify(layoutCheck));
      assert.equal(layoutCheck.undersized, 0);
      await browser.screenshot(resolve(artifactDirectory, `layout-${locale}-${width}.png`));
      await browser.evaluate('document.querySelector("[data-mobile-layout-key-list]").scrollIntoView({block:"start"})');
      await browser.screenshot(resolve(artifactDirectory, `keys-${locale}-${width}.png`));
    }
    await writeFile(resolve(artifactDirectory, "metrics.json"), JSON.stringify({ status: "passed", checks: ["move-and-focus", "undo-preset", "visibility-preview", "touch-reorder-adjacent", "add-edit-lossless", "delete-undo", "reset-undo", "375px-en-zh-no-overflow", "44px-controls"] }, null, 2));
    return { scenario: "mobile-layout", status: "passed", artifactDirectory };
  } catch (error) {
    await writeFile(resolve(artifactDirectory, "errors.json"), JSON.stringify({ message: error.message, stack: error.stack }, null, 2));
    await browser.screenshot(resolve(artifactDirectory, "failure.png")).catch(() => {});
    throw error;
  } finally {
    try { await browser.close(); } finally { await server.close(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runMobileLayoutScenario(), null, 2));
