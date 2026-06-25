import type { JsonRecord } from "../types";
import {
  mobileSymbolAgentFromHerdrPane,
  type MobileSymbolAgent,
} from "./quick-input";

type ActiveHerdrPaneInfo = {
  selector: string;
  sessionId: string;
};

type MobileSymbolAgentControllerOptions = {
  activeHerdrPane: () => ActiveHerdrPaneInfo | undefined;
  ensureHerdrState: (selector: string) => Promise<boolean>;
  readCurrentPane: (selector: string) => Promise<JsonRecord | undefined>;
  onChange: () => void;
};

export function createMobileSymbolAgentController(options: MobileSymbolAgentControllerOptions) {
  let agent: MobileSymbolAgent = "default";
  let refreshKey = "";
  let refreshTime = 0;
  let request = 0;

  function set(next: MobileSymbolAgent) {
    if (agent === next) return;
    agent = next;
    options.onChange();
  }

  return {
    current: () => agent,
    reset() {
      set("default");
    },
    invalidate() {
      refreshTime = 0;
    },
    async refresh() {
      const pane = options.activeHerdrPane();
      if (!pane) {
        set("default");
        return;
      }
      const key = `${pane.selector}:${pane.sessionId}`;
      const now = Date.now();
      if (refreshKey === key && now - refreshTime < 5000) return;
      refreshKey = key;
      refreshTime = now;
      const currentRequest = ++request;
      try {
        if (!await options.ensureHerdrState(pane.selector)) {
          set("default");
          return;
        }
        const result = await options.readCurrentPane(pane.selector);
        if (currentRequest !== request) return;
        set(mobileSymbolAgentFromHerdrPane(result));
      } catch {
        if (currentRequest === request) set("default");
      }
    },
  };
}
