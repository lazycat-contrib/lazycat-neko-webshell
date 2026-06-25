import type { MessageKey } from "../../i18n";
import {
  parseLightOsForwards,
  recordValue,
  stringValue,
} from "../../network-plugin-data";
import { LIGHTOS_PORT_FORWARD_PLUGIN_ID } from "../../plugin-utils";
import type { Tone } from "../../types";
import { errorMessage } from "../../utils";
import type { PluginJsonInvoker } from "../invoke-json";
import type { LightOsForwardInfo } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type LightOsPortForwardState = {
  remoteHost: string;
  remotePort: string;
  forwards: LightOsForwardInfo[];
  loading: boolean;
  loaded: boolean;
  output: string;
};

type LightOsPortForwardControllerDeps = {
  isEnabled: () => boolean;
  sessionId: () => string | undefined;
  invokeJson: PluginJsonInvoker;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  onRender: () => void;
  onLocalUrl: (localUrl: string) => void;
};

export function createLightOsPortForwardController(deps: LightOsPortForwardControllerDeps) {
  const state: LightOsPortForwardState = {
    remoteHost: "127.0.0.1",
    remotePort: "3000",
    forwards: [],
    loading: false,
    loaded: false,
    output: "",
  };

  function setOutput(message: string, tone: Tone = "neutral") {
    state.output = message;
    deps.onStatus(message, tone);
    deps.onRender();
  }

  async function invoke(operation: string, metadata: Record<string, string>) {
    const sessionId = deps.sessionId();
    if (!sessionId) {
      setOutput(deps.tr("status.pluginFileNoSession"), "error");
      return;
    }
    state.loading = true;
    deps.onRender();
    try {
      const payload = await deps.invokeJson(LIGHTOS_PORT_FORWARD_PLUGIN_ID, sessionId, operation, metadata);
      state.forwards = parseLightOsForwards(payload);
      state.loaded = true;
      const forward = recordValue(payload, "forward");
      const localUrl = stringValue(forward, "localUrl");
      if (localUrl) {
        state.output = localUrl;
        deps.onLocalUrl(localUrl);
      } else {
        state.output = deps.tr("status.portForwardReady", { count: state.forwards.length });
      }
      deps.onStatus(deps.tr("status.portForwardReady", { count: state.forwards.length }), "ok");
    } catch (error) {
      setOutput(errorMessage(error), "error");
    } finally {
      state.loading = false;
      deps.onRender();
    }
  }

  return {
    state: () => state,
    updateField(field: string, value: string) {
      if (field === "remoteHost") {
        state.remoteHost = value;
      } else if (field === "remotePort") {
        state.remotePort = value;
      }
    },
    async runAction(action: string) {
      if (!deps.isEnabled()) return;
      if (action === "list" || action === "default" || action === "status") {
        await this.list();
        return;
      }
      if (action !== "acquire") return;
      const remotePort = Number(state.remotePort);
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        setOutput(deps.tr("validation.port"), "error");
        return;
      }
      await invoke("acquire", {
        remoteHost: state.remoteHost || "127.0.0.1",
        remotePort: String(remotePort),
      });
    },
    async list() {
      if (!deps.isEnabled()) return;
      await invoke("list", {});
    },
    async release(forwardId: string) {
      if (!forwardId || !deps.isEnabled()) return;
      await invoke("release", { forwardId });
    },
  };
}
