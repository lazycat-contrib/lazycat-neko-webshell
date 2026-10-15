import "/src/frontend/src/styles.css";
import "/src/frontend/src/mobile/styles.css";
import "/src/frontend/src/mobile/keyboard-dock.css";
import "/src/frontend/src/herdr-activity.css";
import "/src/frontend/src/program-status.css";
import { renderShell } from "/src/frontend/src/shell.ts";
import { syncTabsView } from "/src/frontend/src/navigation-views.ts";
import { applyProgramStatus, programStatusForTab } from "/src/frontend/src/program-status.ts";
import { parseTerminalServerMessage } from "/src/frontend/src/terminal-protocol.ts";
import { translate } from "/src/frontend/src/i18n.ts";
import { updateViewportMetrics } from "/src/frontend/src/app-viewport.ts";
const shell = renderShell(document.querySelector("#app")!);
const viewport = () => updateViewportMetrics({ keyboardInsetThresholdPx: 80 });
viewport(); window.addEventListener("resize", viewport);
shell.emptyState.hidden = true;
const workspace = await fetch("/bridge/workspace").then(r => r.json());
const state = workspace.tabs[0];
const pane = { id: state.panes[0].id, sessionBackend: "webshell", connectionState: "connected", exited: false, closing: false, programStatus: undefined };
const tab = { id: state.id, panes: [pane] };
const tr = (key: string) => translate("en", key);
const qa = { pane, tab, output: "", jumps: [] as string[], statuses: [] as unknown[], socket: undefined as WebSocket | undefined, ready: false, connected: false, send: (text: string) => qa.socket!.send(text) };
function render() {
  const status = programStatusForTab(tab, tr);
  syncTabsView(shell.tabList, [{ id: tab.id, active: true, renaming: false, named: true, pinned: false, pinnedGlyph: "T", canMovePinnedPrevious: false, canMovePinnedNext: false, displayName: "WebShell", title: status?.label ?? "WebShell", tone: "ok", programStatus: status }], { empty: "Empty", rename: "Rename", close: "Close", pin: "Pin", unpin: "Unpin", movePinnedPrevious: "Previous", movePinnedNext: "Next" });
}
shell.tabList.addEventListener("click", event => {
  const node = (event.target as Element).closest<HTMLElement>("[data-program-status-pane]");
  if (node?.dataset.programStatusPane) qa.jumps.push(node.dataset.programStatusPane);
});
const socket = new WebSocket(`${location.origin.replace("http", "ws")}/bridge/pty?pane=${encodeURIComponent(pane.id)}`);
qa.socket = socket;
socket.binaryType = "arraybuffer";
const decoder = new TextDecoder();
socket.addEventListener("message", event => {
  if (event.data instanceof ArrayBuffer) { qa.output += decoder.decode(event.data, { stream: true }); return; }
  const message = parseTerminalServerMessage(event.data);
  if (message?.type === "program-status") { qa.statuses.push(message.records); if (applyProgramStatus(pane, message.records)) render(); }
  if (message?.type === "replay-complete") qa.connected = true;
});
render();
Object.assign(window, { qa });
qa.ready = true;
