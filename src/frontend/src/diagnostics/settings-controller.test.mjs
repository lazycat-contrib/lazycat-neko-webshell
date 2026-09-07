import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalTrace } from "./terminal-trace.ts";
import { createTerminalDiagnosticsSettings } from "./settings-controller.ts";
const tick = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
function setup(extra = {}) {
  const copy = new EventTarget(), download = new EventTarget(), status = { textContent: "" };
  const root = { hidden: false, querySelector: selector => selector.includes("copy") ? copy : selector.includes("download") ? download : status };
  const trace = createTerminalTrace({ now: () => 0 });
  const copied = [], downloaded = [];
  const controller = createTerminalDiagnosticsSettings({ root, trace, tr: key => key,
    copy: async json => copied.push(JSON.parse(json)), download: json => downloaded.push(JSON.parse(json)), ...extra,
  });
  controller.setEnabled(false);
  return { controller, trace, copy, download, status, root, copied, downloaded };
}

test("existing debug opt-in gates copy/download; disabling clears trace and hides controls", async () => {
  const s = setup();
  s.copy.dispatchEvent(new Event("click")); assert.equal(s.copied.length, 0); assert.equal(s.root.hidden, true);
  s.controller.setEnabled(true); s.trace.record({}, "connect-requested");
  s.copy.dispatchEvent(new Event("click")); s.download.dispatchEvent(new Event("click")); await tick();
  assert.equal(s.copied[0].panes.length, 1); assert.equal(s.downloaded[0].panes.length, 1);
  assert.equal(s.status.textContent, "status.terminalDiagnosticsCopied");
  s.controller.setEnabled(false); assert.equal(s.root.hidden, true); assert.equal(s.status.textContent, ""); assert.deepEqual(s.trace.snapshot().panes, []);
});

test("disposal removes listeners and late clipboard completion cannot repopulate status", async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const s = setup({ copy: () => pending }); s.controller.setEnabled(true);
  s.copy.dispatchEvent(new Event("click")); s.controller.dispose(); s.controller.dispose(); release(); await tick();
  assert.equal(s.status.textContent, ""); assert.equal(s.root.hidden, true); assert.deepEqual(s.trace.snapshot().panes, []);
  s.download.dispatchEvent(new Event("click")); assert.equal(s.downloaded.length, 0);
});

test("clipboard errors expose only localized failure copy", async () => {
  const s = setup({ copy: async () => { throw Error("token=private-secret"); } }); s.controller.setEnabled(true);
  s.copy.dispatchEvent(new Event("click")); await tick();
  assert.equal(s.status.textContent, "status.terminalDiagnosticsExportFailed");
});
