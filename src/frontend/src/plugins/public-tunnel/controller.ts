import type { MessageKey } from "../../i18n";
import {
  parsePublicTunnels,
  recordValue,
  stringValue,
} from "../../network-plugin-data";
import { PUBLIC_TUNNEL_PLUGIN_ID } from "../../plugin-utils";
import type { Tone } from "../../types";
import { errorMessage } from "../../utils";
import type { PluginJsonInvoker } from "../invoke-json";
import {
  publicTunnelProviderMetadata,
  syncedPublicTunnelProvider,
} from "./profile-presenter";
import type { PublicTunnelInfo, TunnelProviderProfileSummary } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type PublicTunnelState = {
  provider: string;
  upstreamUrl: string;
  tunnels: PublicTunnelInfo[];
  loading: boolean;
  loaded: boolean;
  output: string;
};

type PublicTunnelControllerDeps = {
  isEnabled: () => boolean;
  sessionId: () => string | undefined;
  profiles: () => TunnelProviderProfileSummary[];
  invokeJson: PluginJsonInvoker;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  onRender: () => void;
};

export function createPublicTunnelController(deps: PublicTunnelControllerDeps) {
  const state: PublicTunnelState = {
    provider: "cloudflare-quick",
    upstreamUrl: "",
    tunnels: [],
    loading: false,
    loaded: false,
    output: "",
  };

  function setOutput(message: string, tone: Tone = "neutral") {
    state.output = message;
    deps.onStatus(message, tone);
    deps.onRender();
  }

  function providerMetadata(): Record<string, string> | undefined {
    syncProviderSelection();
    return publicTunnelProviderMetadata(state.provider, deps.profiles());
  }

  function syncProviderSelection() {
    state.provider = syncedPublicTunnelProvider(state.provider, deps.profiles());
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
      const payload = await deps.invokeJson(PUBLIC_TUNNEL_PLUGIN_ID, sessionId, operation, metadata);
      state.tunnels = parsePublicTunnels(payload);
      state.loaded = true;
      const session = recordValue(payload, "session");
      const publicUrl = stringValue(session, "publicUrl");
      state.output = publicUrl || deps.tr("status.publicTunnelReady", { count: state.tunnels.length });
      deps.onStatus(deps.tr("status.publicTunnelReady", { count: state.tunnels.length }), "ok");
    } catch (error) {
      setOutput(errorMessage(error), "error");
    } finally {
      state.loading = false;
      deps.onRender();
    }
  }

  return {
    state: () => state,
    currentProvider: () => state.provider,
    setProvider(provider: string) {
      state.provider = provider.startsWith("ngrok:") ? provider : "cloudflare-quick";
    },
    syncProviderSelection,
    setUpstreamIfEmpty(localUrl: string) {
      if (localUrl && !state.upstreamUrl) {
        state.upstreamUrl = localUrl;
      }
    },
    useUpstreamUrl(localUrl: string) {
      if (!localUrl) return;
      state.upstreamUrl = localUrl;
      deps.onRender();
    },
    updateField(field: string, value: string) {
      if (field === "provider") {
        this.setProvider(value);
      } else if (field === "upstreamUrl") {
        state.upstreamUrl = value;
      }
    },
    async runAction(action: string) {
      if (!deps.isEnabled()) return;
      if (action === "list" || action === "default" || action === "status") {
        await this.list();
        return;
      }
      if (action !== "start") return;
      const upstreamUrl = state.upstreamUrl.trim();
      if (!upstreamUrl) {
        setOutput(deps.tr("validation.upstreamUrl"), "error");
        return;
      }
      const provider = providerMetadata();
      if (!provider) {
        setOutput(deps.tr("validation.tunnelProfile"), "error");
        return;
      }
      await invoke("start", { ...provider, upstreamUrl });
    },
    async list() {
      if (!deps.isEnabled()) return;
      await invoke("list", {});
    },
    async stop(tunnelId: string) {
      if (!tunnelId || !deps.isEnabled()) return;
      await invoke("stop", { tunnelId });
    },
  };
}
