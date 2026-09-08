import "../../src/frontend/src/styles.css";
import "../../src/frontend/src/plugin-tools.css";
import { createHerdrHistoryDialog } from "../../src/frontend/src/herdr-history/view.ts";
import { translate } from "../../src/frontend/src/i18n.ts";
const records: unknown[] = [];
let mode = "native", clickTask = false;
const locale = new URLSearchParams(location.search).get("locale") === "zh-CN" ? "zh-CN" : "en";
document.addEventListener("click", () => { clickTask = true; setTimeout(() => { clickTask = false; }, 0); }, true);
const nativeWrite = navigator.clipboard.write.bind(navigator.clipboard);
Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: (items: ClipboardItem[]) => {
  records.push({ native: true, clickTask, active: navigator.userActivation.isActive });
  return mode === "native" ? nativeWrite(items) : Promise.reject(new Error("Permission denied"));
} });
const nativeExec = document.execCommand.bind(document);
document.execCommand = (command) => {
  const active = document.activeElement;
  records.push({ fallback: true, inside: Boolean(active?.closest("dialog[open]")), value: active instanceof HTMLTextAreaElement ? active.value : "" });
  return mode === "denied" ? false : nativeExec(command);
};
const dialog = createHerdrHistoryDialog({ tr: (key, values) => translate(locale, key, values), prepare: () => {},
  target: () => ({ selector: "isolated", generation: 1, paneId: "outer", sessionId: "fixture" }),
  request: async (method, params) => {
    await new Promise(resolve => setTimeout(resolve, 60));
    return { result: method === "pane.list" ? { panes: [{ pane_id: "inner", workspace_id: "space", tab_id: "tab", title: "Fixture shell" }] }
      : method === "pane.copy_motion" ? { pane_id: params.pane_id, cursor: { row: 0, col: 0 }, content_revision: 2 }
      : method === "pane.copy_search" ? { pane_id: params.pane_id, content_revision: 2, matches: [{ start: { row: 0, col: 0 }, end: { row: 0, col: 4 } }], current: 0, current_global: 0, total: 1 }
      : { pane_id: params.pane_id, text: "hello" } };
  },
});
document.querySelector("#open")!.addEventListener("click", () => void dialog.open());
Object.assign(window, { historyFixture: { records: () => records, mode: (next: string) => { mode = next; records.length = 0; }, ready: true } });
