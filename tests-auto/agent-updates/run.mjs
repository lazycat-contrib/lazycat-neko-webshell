import assert from "node:assert/strict";
import { createBrowserDriver, uniqueBrowserSession } from "../browser-driver.mjs";
import { createSettingsUiPreview } from "../settings-ui/preview-server.mjs";
import { fileURLToPath } from "node:url";

export async function runAgentUpdateScenario() {
  const server = await createSettingsUiPreview(0, { agentKind: "optional" });
  const browser = createBrowserDriver({ session: uniqueBrowserSession("agent-updates"), headed: false });
  try {
    await browser.open(`http://127.0.0.1:${server.httpServer.address().port}/?name=preview@owner`);
    await browser.waitFor('document.querySelector("#agentUpdateButton")&&!document.querySelector("#agentUpdateButton").hidden');
    assert.equal(server.agentUpdateCalls.length, 0);
    await browser.command(["click", "#agentUpdateButton"]);
    await browser.waitFor('document.querySelector("[data-agent-update=prepare]")');
    await browser.command(["click", "[data-agent-update=later]"]);
    assert.equal(await browser.evaluate('document.querySelector("#agentUpdateButton").hidden'), true);
    await browser.command(["click", "[data-agent-update=prepare]"]);
    await browser.waitFor('document.querySelector("#agentUpdateSettings").textContent.includes("next restarts")');
    assert.equal(server.agentUpdateCalls.length, 1);
    assert.equal(server.agentUpdateCalls[0].optional, true);
    await browser.command(["click", "#closeSettings"]);
    server.setAgentKind("required");
    await browser.command(["click", "#settingsButton"]);
    await browser.command(["click", "#openSettingsItem"]);
    await browser.command(["click", "[data-settings-tab=terminal]"]);
    await browser.waitFor('document.querySelector("#agentUpdateSettings").textContent.includes("is ready")');
    assert.equal(server.agentUpdateCalls.length, 2);
    assert.equal(server.agentUpdateCalls[1].optional, false);
    return { status: "passed", name: "agent-updates" };
  } finally { await browser.close().catch(() => {}); await server.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAgentUpdateScenario().then((value) => console.log(JSON.stringify(value))).catch((error) => { console.error(error); process.exitCode = 1; });
}
