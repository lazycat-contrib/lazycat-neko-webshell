import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function runMobileKeyboardScenario() {
  const artifacts = join(root, "tests-auto/artifacts", `mobile-keyboard-${Date.now()}`);
  await mkdir(artifacts, { recursive: true });
  const browser = createBrowserDriver({ session: uniqueBrowserSession("mobile-keyboard"), headed: true });
  let server, failure;
  const results = [];
  const touch = (type, point, id = 1, delayMs = 0) => ({ type, delayMs, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ ...point, id, radiusX: 2, radiusY: 2, force: 1 }] });
  try {
    server = await createServer({ configFile: false, root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    await browser.open(`http://127.0.0.1:${server.httpServer.address().port}/tests-auto/mobile-keyboard/`);
    await browser.command(["set", "viewport", "390", "800"]);
    await browser.waitFor("window.keyboardProbe !== undefined");
    for (const selector of ["[data-mobile-shortcut='escape']", "[data-mobile-repeat]", "[data-mobile-text]", "[data-mobile-action='toggle-system-keyboard']", "[data-mobile-action='pane-menu']"]) {
      await browser.evaluate("window.keyboardProbe.clear()");
      const point = await browser.evaluate(`window.keyboardProbe.point(${JSON.stringify(selector)})`);
      await browser.dispatchTouch([touch("touchStart", point, 1, 30), touch("touchMove", { x: point.x + 110, y: point.y - 18 }, 1, 30), touch("touchEnd", point)]);
      const events = await browser.evaluate("window.keyboardProbe.events()");
      results.push({ scenario: "swipe", selector, events });
      assert.deepEqual(events, [], `${selector} swipe must not emit input`);
    }
    await browser.screenshot(join(artifacts, "swipe.png"));
    for (const selector of ["[data-mobile-shortcut='escape']", "[data-mobile-repeat]", "[data-mobile-text]", "[data-mobile-action='toggle-system-keyboard']", "[data-mobile-action='pane-menu']"]) {
      await browser.evaluate("window.keyboardProbe.clear()");
      const point = await browser.evaluate(`window.keyboardProbe.point(${JSON.stringify(selector)})`);
      await browser.dispatchTouch([touch("touchStart", point, 2, 40), touch("touchEnd", point)]);
      await browser.waitFor("window.keyboardProbe.events().length === 1");
      const events = await browser.evaluate("window.keyboardProbe.events()");
      assert.equal(events.length, 1, "tap and compatibility click must activate once");
      if (selector.includes("toggle-system-keyboard")) {
        assert.equal(events[0].phase, "pointerup", "system keyboard action must run synchronously in release");
        assert.equal(events[0].active, true, "system keyboard retains trusted user activation");
        assert.equal(events[0].releaseTask, true, "system keyboard must not defer to a later task");
      }
      results.push({ scenario: "tap", selector, events });
    }
    await browser.evaluate("window.keyboardProbe.clear(); document.querySelector('[data-mobile-shortcut=escape]').focus()");
    await browser.press("Enter");
    let events = await browser.evaluate("window.keyboardProbe.events()");
    assert.equal(events.length, 1, "keyboard activation works without a pointer");
    assert.equal(events[0].phase, "click");
    results.push({ scenario: "keyboard-activation", events });
    await browser.evaluate("window.keyboardProbe.clear()");
    let point = await browser.evaluate("window.keyboardProbe.point('[data-mobile-repeat]')");
    await browser.dispatchTouch([touch("touchStart", point, 3, 460), touch("touchMove", { x: point.x + 75, y: point.y - 22 }, 3, 30), touch("touchEnd", point)]);
    events = await browser.evaluate("window.keyboardProbe.events()");
    assert.ok(events.length >= 1, "holding repeat starts after its delay");
    const repeatCount = events.length;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await browser.evaluate("window.keyboardProbe.events()")).length, repeatCount, "movement cancels future repeats and the release byte");
    results.push({ scenario: "hold-repeat-then-cancel", count: repeatCount });
    await browser.evaluate("window.keyboardProbe.clear()");
    point = await browser.evaluate("window.keyboardProbe.point('[data-mobile-repeat]')");
    await browser.evaluate("window.keyboardProbe.scrollDuringNextHold()");
    await browser.dispatchTouch([touch("touchStart", point, 6, 440), touch("touchEnd", point, 6)]);
    assert.deepEqual(await browser.evaluate("window.keyboardProbe.events()"), [], "keyboard scrolling cancels a held key even without pointer movement");
    results.push({ scenario: "scroll-cancels-pending-repeat", events: [] });
    await browser.evaluate("window.keyboardProbe.clear()");
    point = await browser.evaluate("window.keyboardProbe.point('[data-mobile-shortcut=escape]')");
    await browser.dispatchTouch([touch("touchStart", point, 4, 30), touch("touchCancel", point)]);
    assert.deepEqual(await browser.evaluate("window.keyboardProbe.events()"), [], "canceled touch sends no byte");
    await browser.evaluate("window.keyboardProbe.dispose()");
    await browser.dispatchTouch([touch("touchStart", point, 5, 30), touch("touchEnd", point)]);
    await browser.evaluate("document.querySelector('[data-mobile-shortcut=escape]').click()");
    assert.deepEqual(await browser.evaluate("window.keyboardProbe.events()"), [], "disposed controller has no gesture/click side effects");
    results.push({ scenario: "cancel-and-dispose", events: [] });
    await browser.screenshot(join(artifacts, "complete.png"));
  } catch (error) {
    failure = error;
    await browser.screenshot(join(artifacts, "failure.png")).catch(() => {});
  } finally {
    const cleanupErrors = [];
    try { await browser.close(); } catch (error) { cleanupErrors.push(error.message); }
    try { await server?.close(); } catch (error) { cleanupErrors.push(error.message); }
    if (cleanupErrors.length && !failure) failure = new Error(`Cleanup failed: ${cleanupErrors.join("; ")}`);
    await writeFile(join(artifacts, "results.json"), JSON.stringify({ results, error: failure?.message ?? null, cleanupErrors }, null, 2));
  }
  if (failure) { failure.message += `\nArtifacts: ${artifacts}`; throw failure; }
  return { scenario: "mobile-keyboard", status: "passed", artifactDirectory: artifacts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMobileKeyboardScenario().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
