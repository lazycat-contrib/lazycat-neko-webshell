import type { Client } from "@connectrpc/connect";

import type { JsonRecord } from "../types";

type CapabilityClient = Client<typeof import("../gen/lazycat/webshell/v1/capability_pb").CapabilityService>;

const NETWORK_PLUGIN_TIMEOUT_MS = 70000;

export type PluginJsonInvoker = (
  pluginId: string,
  sessionId: string,
  operation: string,
  metadata: Record<string, string>,
) => Promise<JsonRecord>;

export function createPluginJsonInvoker(capabilityClient: CapabilityClient): PluginJsonInvoker {
  return async (pluginId, sessionId, operation, metadata) => {
    const response = await capabilityClient.invokePlugin({
      pluginId,
      sessionId,
      operation,
      contentType: "application/json",
      metadata,
    }, { timeoutMs: NETWORK_PLUGIN_TIMEOUT_MS });
    const text = new TextDecoder().decode(response.payload);
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("plugin returned invalid JSON");
    }
    return parsed as JsonRecord;
  };
}
