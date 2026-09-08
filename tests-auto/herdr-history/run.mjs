import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";
export async function runHerdrHistoryScenario() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const artifactDirectory = resolve(root, "tests-auto/artifacts/herdr-history", `${Date.now()}-${process.pid}`);
  await mkdir(artifactDirectory, { recursive: true });
  const browser = createBrowserDriver({ session: uniqueBrowserSession("herdr-history"), headed: true });
  const server = await createServer({ configFile: false, root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
  const results = [];
  try {
    await server.listen();
    await browser.open(`http://127.0.0.1:${server.httpServer.address().port}/tests-auto/herdr-history/index.html?locale=zh-CN`);
    await browser.command(["set", "viewport", "375", "812"]);
    await browser.waitFor("window.historyFixture?.ready");
    await browser.command(["click", "#open"]);
    await browser.waitFor("document.querySelector('dialog select')?.options.length === 2");
    await browser.command(["select", "dialog select", "inner"]);
    await browser.command(["fill", "dialog input", "hello"]);
    await browser.command(["click", "[data-history-search=forward]"]);
    await browser.waitFor("document.querySelector('dialog pre')?.textContent === 'hello'");
    for (const mode of ["native", "fallback", "denied"]) {
      await browser.evaluate(`window.historyFixture.mode(${JSON.stringify(mode)})`);
      await browser.command(["click", "[data-history-copy]"]);
      await browser.waitFor("!document.querySelector('[data-history-copy]').disabled");
      const records = await browser.evaluate("window.historyFixture.records()");
      assert.equal(records[0]?.clickTask, true, "clipboard initiation must stay in the click task");
      assert.equal(records[0]?.active, true);
      const status = await browser.evaluate("document.querySelector('[data-history-status]').textContent");
      if (mode === "denied") {
        assert.match(status, /手动复制/);
        assert.equal(await browser.evaluate("document.querySelector('dialog pre').textContent"), "hello");
      } else {
        assert.match(status, /已复制/);
        if (mode === "native") assert.equal(records.length, 1, "real ClipboardItem write should succeed");
      }
      if (mode !== "native") assert.deepEqual(records[1], { fallback: true, inside: true, value: "hello" });
      results.push({ mode, records, status });
    }
    await browser.evaluate("document.querySelector('[data-history-close]').focus()");
    await browser.press("Shift+Tab");
    assert.equal(await browser.evaluate("document.activeElement?.tagName"), "PRE");
    await browser.press("Tab");
    assert.equal(await browser.evaluate("document.activeElement?.hasAttribute('data-history-close')"), true);
    assert.ok(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"));
    await browser.screenshot(resolve(artifactDirectory, "history-mobile.png"));
    await browser.press("Escape");
    assert.equal(await browser.evaluate("document.activeElement?.id"), "open");
    await writeFile(resolve(artifactDirectory, "metrics.json"), JSON.stringify({ status: "passed", results }, null, 2));
    return { scenario: "herdr-history", status: "passed", artifactDirectory };
  } catch (error) {
    await writeFile(resolve(artifactDirectory, "errors.json"), JSON.stringify({ message: error.message, stack: error.stack }, null, 2));
    await browser.screenshot(resolve(artifactDirectory, "failure.png")).catch(() => {});
    throw error;
  } finally { try { await browser.close(); } finally { await server.close(); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runHerdrHistoryScenario(), null, 2));
