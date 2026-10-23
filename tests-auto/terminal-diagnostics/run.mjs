import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";
import { createSettingsUiPreview } from "../settings-ui/preview-server.mjs";

export async function runTerminalDiagnosticsScenario() {
  const artifacts = fileURLToPath(new URL("../artifacts/terminal-diagnostics/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const server = await createSettingsUiPreview();
  const browser = createBrowserDriver({ session: uniqueBrowserSession("terminal-diagnostics"), headed: false });
  const click = selector => browser.command(["click", selector]);
  const openPluginSettings = async () => {
    await click("#settingsButton");
    await click("#openSettingsItem");
    await click("[data-settings-tab=plugins]");
    await browser.waitFor('document.querySelectorAll(".plugin-item").length===9');
  };
  try {
    await browser.open(`http://127.0.0.1:${server.httpServer.address().port}`);
    await browser.waitFor('document.querySelector("#settingsButton")');
    await openPluginSettings();
    assert.equal(await browser.evaluate('document.querySelector("[data-plugin-toggle=terminal-diagnostics]").checked'), false);
    await click("[data-plugin-toggle=terminal-diagnostics]");
    await browser.waitFor('!document.querySelector("[data-plugin-toggle=terminal-diagnostics]").disabled');
    await click("#closeSettings");
    await click("#pluginsButton");
    await click("[data-plugin-tool=terminal-diagnostics]");
    await browser.waitFor('document.querySelector(".terminal-diagnostics-tool")');
    assert.equal(await browser.evaluate('document.querySelectorAll(".terminal-diagnostics-summary dd").length'), 3);
    await click("[data-terminal-diagnostics-action=refresh]");
    await browser.screenshot(`${artifacts}/desktop.png`);
    const download = `${artifacts}/terminal-diagnostics.json`;
    await browser.command(["download", "[data-terminal-diagnostics-action=download]", download]);
    const exported = JSON.parse(await readFile(download, "utf8"));
    assert.equal(exported.version, 1);
    assert.equal(exported.trace.enabled, true);
    assert.ok(Array.isArray(exported.trace.panes));
    assert.equal(typeof exported.performance, "object");
    await browser.command(["set", "viewport", "375", "812"]);
    assert.equal(await browser.evaluate('(()=>{const panel=document.querySelector("#pluginToolBody");return panel.scrollWidth<=panel.clientWidth})()'), true);
    await browser.screenshot(`${artifacts}/mobile.png`);
    await click("#closePluginSidebar");
    await openPluginSettings();
    await click("[data-plugin-toggle=terminal-diagnostics]");
    await browser.waitFor('!document.querySelector("[data-plugin-toggle=terminal-diagnostics]").disabled');
    await click("#closeSettings");
    await click("#pluginsButton");
    assert.equal(await browser.evaluate('Boolean(document.querySelector("[data-plugin-tool=terminal-diagnostics]"))'), false);
    return { status: "passed", name: "terminal-diagnostics", artifacts };
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}
