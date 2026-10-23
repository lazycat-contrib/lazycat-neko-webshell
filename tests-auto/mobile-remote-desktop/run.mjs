import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";
import { createSettingsUiPreview } from "../settings-ui/preview-server.mjs";

export async function runMobileRemoteDesktopScenario() {
  const artifacts = fileURLToPath(new URL("../artifacts/mobile-remote-desktop/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const server = await createSettingsUiPreview(0, { lightosEnabled: true });
  const browser = createBrowserDriver({ session: uniqueBrowserSession("mobile-remote-desktop"), headed: false });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const click = selector => browser.command(["click", selector]);
  const openSettings = async () => {
    await browser.waitFor('document.querySelector("#settingsButton") && !document.querySelector("#homeButton").hidden');
    await click("#settingsButton");
    await click("#openSettingsItem");
    await click("[data-settings-tab=terminal]");
  };
  try {
    await browser.open(origin);
    await browser.command(["set", "viewport", "1280", "900"]);
    await openSettings();
    assert.equal(await browser.evaluate('document.querySelector("#debugMode").checked'), false);
    assert.equal(await browser.evaluate('document.querySelector("#mobileRemoteDesktopEnabled").getClientRects().length'), 0);
    await click("#debugMode");
    await browser.waitFor('document.querySelector("#mobileRemoteDesktopEnabled").getClientRects().length > 0');
    assert.equal(await browser.evaluate('document.querySelector("#mobileRemoteDesktopEnabled").checked'), false);
    await browser.screenshot(`${artifacts}/desktop.png`);
    await browser.command(["set", "viewport", "375", "812"]);
    await click("#mobileRemoteDesktopEnabled");
    assert.equal(await browser.evaluate('localStorage.getItem("lightos-mobile-remote-desktop-enabled")'), "true");
    await browser.waitFor('fetch("/api/settings").then(r=>r.json()).then(s=>s.debugMode===true)');
    assert.equal(await browser.evaluate('(()=>{const panel=document.querySelector(".settings-panels");return panel.scrollWidth<=panel.clientWidth})()'), true);
    await browser.screenshot(`${artifacts}/mobile.png`);

    await browser.navigate(origin);
    await openSettings();
    assert.equal(await browser.evaluate('document.querySelector("#mobileRemoteDesktopEnabled").checked'), true);
    await click("#debugMode");
    assert.equal(await browser.evaluate('document.querySelector("#mobileRemoteDesktopEnabled").getClientRects().length'), 0);
    assert.equal(await browser.evaluate('localStorage.getItem("lightos-mobile-remote-desktop-enabled")'), "true");
    await browser.waitFor('fetch("/api/settings").then(r=>r.json()).then(s=>s.debugMode===false)');
    await click("#closeSettings");
    await click("#settingsButton");
    await click("#homeButton");
    await browser.waitFor('location.pathname === "/lightos-test-home"');
    assert.deepEqual(await browser.evaluate('({view:new URL(location.href).searchParams.get("view"),desktop:new URL(location.href).searchParams.get("mobile_remote_desktop"),keep:new URL(location.href).searchParams.get("keep"),hash:location.hash})'),
      { view: "home", desktop: "1", keep: "value", hash: "#instances" });

    await browser.navigate(origin);
    await openSettings();
    await click("#debugMode");
    assert.equal(await browser.evaluate('document.querySelector("#mobileRemoteDesktopEnabled").checked'), true);
    await click("#mobileRemoteDesktopEnabled");
    await click("#closeSettings");
    await click("#settingsButton");
    await click("#homeButton");
    await browser.waitFor('location.pathname === "/lightos-test-home"');
    assert.equal(await browser.evaluate('new URL(location.href).searchParams.get("mobile_remote_desktop")'), "0");

    server.setLightosEnabled(false);
    await browser.navigate(origin);
    await browser.waitFor('document.querySelector("#homeButton").hidden');
    assert.equal(await browser.evaluate('document.querySelector("#mobileRemoteDesktopSettings").hidden'), true);
    return { status: "passed", name: "mobile-remote-desktop", artifacts };
  } catch (error) {
    await browser.screenshot(`${artifacts}/failure.png`).catch(() => {});
    const state = await browser.evaluate('({url:location.href,title:document.title,status:document.querySelector("#statusLine")?.textContent,home:document.querySelector("#homeButton")?.outerHTML,body:document.body.textContent.slice(-2000)})').catch(() => ({}));
    await writeFile(`${artifacts}/failure.json`, JSON.stringify(state, null, 2));
    throw error;
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}
