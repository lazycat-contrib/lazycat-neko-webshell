import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";

export async function runHerdrNotificationsScenario() {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL("../../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  const browser = createBrowserDriver({ session: uniqueBrowserSession("herdr-notifications"), headed: false });
  try {
    await server.listen();
    await browser.open(`http://127.0.0.1:${server.httpServer.address().port}/tests-auto/herdr-notifications/fixture.html`);
    await browser.waitFor("window.notificationFixture?.refreshes() > 0");
    let refreshes = await browser.evaluate("notificationFixture.refreshes()");
    async function click(selector, alerts) {
      await browser.command(["click", selector]);
      await browser.waitFor(`notificationFixture.refreshes() > ${refreshes}`);
      refreshes = await browser.evaluate("notificationFixture.refreshes()");
      assert.equal(await browser.evaluate('document.querySelectorAll("#alerts li").length'), alerts);
      assert.equal(await browser.evaluate("notificationFixture.sent.length"), alerts);
    }
    assert.equal(await browser.evaluate("notificationFixture.sent.length"), 0);
    await click("#new-tab", 0);
    await click("#reconnect", 0);
    await click("#complete", 1);
    await click("#rename", 1);
    await click("#new-tab", 1);
    await click("#reconnect", 1);
    await click("#complete", 2);
    await click("#blocked", 3);
    await click("#rename", 3);
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("#alerts li")].map(item => item.dataset.kind)'), ["done", "done", "blocked"]);
    return { status: "passed", name: "herdr-notifications" };
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHerdrNotificationsScenario().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
