import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";
import { createSettingsUiPreview } from "./preview-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function runSettingsUiScenario() {
  const artifacts = path.join(root, "tests-auto/artifacts/settings-ui");
  await mkdir(artifacts, { recursive: true });
  const server = await createSettingsUiPreview(0, { configureDelayMs: 1500 });
  const browser = createBrowserDriver({ session: uniqueBrowserSession("settings-ui"), headed: false });
  const evaluate = (source) => browser.evaluate(source);
  const click = (selector) => browser.command(["click", selector]);
  const wait = (source) => browser.waitFor(source);
  const screenshot = async (name) => {
    await evaluate('Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))');
    return browser.screenshot(path.join(artifacts, name + ".png"));
  };
  const openSettings = async () => {
    await click("#settingsButton");
    await click("#openSettingsItem");
    await wait('!document.querySelector("#settingsPage").hidden');
  };
  const selected = () => evaluate('document.querySelector("#settingsTabs [aria-selected=true]").dataset.settingsTab');
  try {
    await browser.open(`http://127.0.0.1:${server.httpServer.address().port}`);
    await browser.command(["set", "viewport", "1280", "900"]);
    await wait('document.querySelector("#settingsButton")');
    await openSettings();
    await screenshot("settings-desktop");
    assert.equal(await evaluate('[...document.querySelectorAll("[data-settings-panel]")].every(panel=>panel.getAttribute("aria-labelledby")&&panel.querySelector(".settings-panel-intro h3"))'), true);
    await click("[data-settings-tab=fonts]");
    assert.equal(await evaluate('[...document.querySelectorAll("[data-font-tab]")].filter(tab=>tab.tabIndex===0).length'), 1);
    await click("[data-settings-tab=appearance]");
    await browser.command(["focus", "[data-settings-tab=appearance]"]);
    await browser.press("ArrowDown");
    assert.equal(await selected(), "terminal");
    assert.equal(await evaluate('document.activeElement.id'), "settings-tab-terminal");
    await browser.press("End");
    assert.equal(await selected(), "plugins");
    await browser.press("Home");
    assert.equal(await selected(), "appearance");
    await browser.command(["focus", "#tabLayout"]);
    await browser.press("Tab");
    assert.equal(await evaluate("document.activeElement.id"), "closeSettings");
    await browser.press("Shift+Tab");
    assert.equal(await evaluate("document.activeElement.id"), "tabLayout");
    await browser.press("Escape");
    assert.equal(await evaluate('document.querySelector("#settingsPage").hidden'), true);
    assert.equal(await evaluate("document.activeElement.id"), "settingsButton");
    await browser.press("Control+Shift+Comma");
    await wait('!document.querySelector("#settingsPage").hidden');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".settings-dialog")).transitionDuration.split(",").every(value=>parseFloat(value)===0)'), true);
    await click("[data-settings-tab=plugins]");
    await wait('document.querySelectorAll(".plugin-item").length===8');
    assert.equal(await evaluate('document.querySelectorAll(".plugin-configuration[open]").length'), 0);
    await screenshot("plugins-desktop");
    await click("[data-plugin-settings=ai-chat] summary");
    await wait('document.querySelector("[data-plugin-settings=ai-chat] summary").getAttribute("aria-expanded")==="true"');
    await browser.command(["focus", "[data-ai-settings-tab=ai]"]);
    await browser.press("ArrowRight");
    assert.equal(await evaluate('document.activeElement.dataset.aiSettingsTab'), "mcp");
    await browser.press("ArrowLeft");
    assert.equal(await evaluate('document.activeElement.dataset.aiSettingsTab'), "ai");
    await click("#refreshPlugins");
    await wait('!document.querySelector("#refreshPlugins").disabled');
    assert.equal(await evaluate('document.querySelector("[data-plugin-settings=ai-chat]").open'), true);
    await screenshot("plugins-expanded-desktop");
    await click("[data-ai-profile-new=true]");
    await wait('document.querySelector("[data-ai-config-modal]")');
    assert.equal(await evaluate('Boolean(document.activeElement.closest("[data-ai-config-modal]"))'), true);
    await browser.press("Control+Shift+Comma");
    assert.equal(await evaluate('Boolean(document.activeElement.closest("[data-ai-config-modal]"))'), true);
    await browser.press("Escape");
    await wait('!document.querySelector("[data-ai-config-modal]")');
    assert.equal(await evaluate('document.querySelector("#settingsPage").hidden'), false);
    assert.equal(await evaluate('document.activeElement.hasAttribute("data-ai-profile-new")'), true);
    await click("[data-plugin-toggle=white-noise]");
    await wait('!document.querySelector("[data-plugin-toggle=white-noise]").disabled');
    assert.equal(await evaluate('document.activeElement.dataset.pluginToggle'), "white-noise");
    await click("[data-plugin-toggle=white-noise]");
    await click("[data-ai-profile-new=true]");
    await browser.command(["fill", '[data-ai-dialog-field="profileName"]', "unsaved profile draft"]);
    await wait('!document.querySelector("[data-plugin-toggle=white-noise]").disabled');
    assert.equal(await evaluate('document.querySelector("[data-ai-dialog-field=profileName]").value'), "unsaved profile draft");
    await browser.press("Escape");
    await click("[data-ai-profile-new=true]");
    assert.notEqual(await evaluate('document.querySelector("[data-ai-dialog-field=profileName]").value'), "unsaved profile draft");
    await browser.press("Escape");
    await click("[data-plugin-toggle=white-noise]");
    await wait('!document.querySelector("[data-plugin-toggle=white-noise]").disabled');
    await browser.command(["set", "viewport", "375", "812"]);
    await click("[data-settings-tab=appearance]");
    assert.equal(await evaluate('document.querySelector("#settingsTabs").getAttribute("aria-orientation")'), "horizontal");
    await browser.command(["focus", "[data-settings-tab=appearance]"]);
    await browser.press("ArrowRight");
    assert.equal(await selected(), "terminal");
    await click("[data-settings-tab=plugins]");
    assert.equal(await evaluate('(()=>{const dialog=document.querySelector(".settings-dialog"),panels=document.querySelector(".settings-panels"),rect=dialog.getBoundingClientRect();return dialog.scrollWidth<=dialog.clientWidth&&panels.scrollWidth<=panels.clientWidth&&rect.top>=0&&rect.bottom<=innerHeight})()'), true);
    await screenshot("plugins-mobile");
    await click("[data-settings-tab=appearance]");
    await browser.command(["select", "#interfaceStyleSelect", "porcelain"]);
    await screenshot("settings-light-mobile");
    await browser.command(["set", "media", "light", "reduced-motion"]);
    await click("[data-settings-tab=plugins]");
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".plugin-switch input"),"::before").transitionDuration.split(",").every(value=>parseFloat(value)===0)'), true);
    await screenshot("plugins-light-mobile");
    await browser.command(["set", "viewport", "812", "375"]);
    assert.equal(await evaluate('(()=>{const r=document.querySelector(".settings-dialog").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'), true);
    await click("#closeSettings");
    await click("#pluginsButton");
    await wait('document.querySelectorAll("[data-plugin-tool]").length>0');
    await browser.command(["set", "viewport", "375", "812"]);
    assert.equal(await evaluate('(()=>{const panel=document.querySelector("#pluginSidebar");return panel.scrollWidth<=panel.clientWidth&&[...panel.querySelectorAll(".plugin-tool-tab-label")].every(label=>getComputedStyle(label).display!=="none"&&label.textContent.trim())})()'), true);
    await screenshot("tools-mobile");
    assert.equal(await evaluate('(()=>{const model=document.querySelector(".ai-chat-model-row > .ai-chat-picker"),row=document.querySelector(".ai-chat-model-row");return model.getBoundingClientRect().width>=row.getBoundingClientRect().width*.45})()'), true);
    await browser.command(["focus", "[data-plugin-tool=ai-chat]"]);
    await browser.press("ArrowRight");
    assert.equal(await evaluate('document.activeElement.dataset.pluginTool'), "file-transfer");
    const errors = JSON.parse(await browser.command(["errors", "--json"]));
    assert.deepEqual(errors.data.errors, []);
    return { status: "passed", name: "settings-ui", artifacts };
  } catch (error) {
    await screenshot("failure").catch(() => {});
    throw error;
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSettingsUiScenario().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
}
