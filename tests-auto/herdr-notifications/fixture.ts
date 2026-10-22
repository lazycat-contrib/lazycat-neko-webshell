import { createHerdrLazycatNotificationController } from "../../src/frontend/src/herdr-notifications/controller.ts";
import { createHerdrEventStreamPolicy } from "../../src/frontend/src/herdr-event-stream-policy.ts";
import { createHerdrEventRefreshLoop } from "../../src/frontend/src/herdr-event-refresh-loop.ts";
import { herdrEventMessage } from "../../src/frontend/src/herdr-event-presentation.ts";
import { translate } from "../../src/frontend/src/i18n.ts";
import type { HerdrBridgeState } from "../../src/frontend/src/types.ts";

let state = {
  herdr_version: "0.9.3", workspaces: [], tabs: [], panes: [],
  agents: [{ terminal_id: "terminal-1", pane_id: "pane-1", workspace_id: "w1", tab_id: "t1",
    display_agent: "xxxa", agent_status: "done", completion_seq: 7 }],
} as unknown as HerdrBridgeState;
const sent: unknown[] = [];
let refreshes = 0;
const stream = createHerdrEventStreamPolicy();
const controller = createHerdrLazycatNotificationController({
  enabled: () => true, state: () => state, tr: (key, values) => translate("zh-CN", key, values),
  send: async (payload) => { sent.push(payload); },
  onError: (error) => { throw error; },
  onTransition: (transition) => {
    const item = document.createElement("li");
    item.dataset.kind = transition.kind;
    item.textContent = herdrEventMessage("pane.agent_status_changed", {
      agent_status: transition.kind, display_agent: transition.displayAgent,
    }, (key, values) => translate("zh-CN", key, values));
    document.querySelector("#alerts")!.append(item);
  },
});
const loop = createHerdrEventRefreshLoop({
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (timer) => window.clearTimeout(timer),
  retryDelay: (token, attempt) => stream.retryDelay(token, attempt),
  run: async () => { controller.reconcile(); refreshes++; return true; },
});
function event(status = "done") {
  const decision = stream.handle({ event: "pane.agent_status_changed", data: {
    pane_id: "pane-1", agent_status: status, display_agent: "xxxa",
  } });
  if (decision.requestReconcile) loop.request(decision.token);
}
function subscribe(paneIds: string[]) {
  loop.reset(); stream.reset(); controller.reset();
  stream.beginSubscription(paneIds); controller.seed();
  // Include delayed working/done history while the authoritative task is already done.
  event("working"); event("done");
}
document.querySelector("#new-tab")!.addEventListener("click", () => subscribe(["pane-1", "new-pane"]));
document.querySelector("#reconnect")!.addEventListener("click", () => subscribe(["pane-1"]));
document.querySelector("#complete")!.addEventListener("click", () => {
  state = { ...state, agents: [{ ...state.agents[0], agent_status: "idle", completion_seq: state.agents[0].completion_seq! + 2 }] };
  event("done");
});
document.querySelector("#blocked")!.addEventListener("click", () => {
  state = { ...state, agents: [{ ...state.agents[0], agent_status: "blocked" }] };
  event("blocked");
});
document.querySelector("#rename")!.addEventListener("click", () => event(state.agents[0].agent_status));
subscribe(["pane-1"]);
Object.assign(window, { notificationFixture: { sent, refreshes: () => refreshes } });
