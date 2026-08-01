import type { MessageKey } from "../i18n";
import type { HerdrBridgeState, JsonRecord } from "../types";
import {
  postHerdrLazycatNotification,
  type HerdrLazycatNotificationPayload,
} from "./api.ts";
import {
  createHerdrNotificationPolicy,
  type HerdrNotificationTransition,
} from "./policy.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type HerdrLazycatNotificationControllerDeps = {
  enabled: () => boolean;
  state: () => HerdrBridgeState | undefined;
  tr: Translate;
  send?: (payload: HerdrLazycatNotificationPayload) => Promise<void>;
  onError: (error: unknown) => void;
};

export function createHerdrLazycatNotificationController(
  deps: HerdrLazycatNotificationControllerDeps,
) {
  const policy = createHerdrNotificationPolicy();
  const send = deps.send ?? postHerdrLazycatNotification;

  return {
    seed() {
      policy.seed(deps.state()?.panes ?? []);
    },

    handle(event: string, data: JsonRecord) {
      const transition = policy.handle(event, data);
      if (!transition || !deps.enabled()) return;
      void send(notificationPayload(transition, deps.state(), deps.tr)).catch(deps.onError);
    },

    reset() {
      policy.reset();
    },
  };
}

function notificationPayload(
  transition: HerdrNotificationTransition,
  state: HerdrBridgeState | undefined,
  tr: Translate,
): HerdrLazycatNotificationPayload {
  const pane = state?.panes.find((item) => item.pane_id === transition.paneId);
  const tab = state?.tabs.find((item) => item.tab_id === pane?.tab_id);
  const workspaceId = transition.workspaceId || pane?.workspace_id || "";
  const workspace = state?.workspaces.find((item) => item.workspace_id === workspaceId);
  const agent = transition.displayAgent
    || transition.agent
    || pane?.display_agent?.trim()
    || pane?.agent?.trim()
    || tr("herdr.agentFallback");
  const workspaceLabel = workspace?.label.trim()
    || (workspace?.number
      ? tr("herdr.workspaceFallback", { number: workspace.number })
      : tr("herdr.workspaceFallbackPlain"));
  const tabLabel = tab?.label.trim()
    || (tab?.number
      ? tr("herdr.tabFallback", { number: tab.number })
      : tr("herdr.tabFallbackPlain"));

  return {
    title: tr(transition.kind === "done"
      ? "herdrNotification.doneTitle"
      : "herdrNotification.blockedTitle"),
    body: tr("herdrNotification.context", {
      agent,
      workspace: workspaceLabel,
      tab: tabLabel,
    }),
  };
}
