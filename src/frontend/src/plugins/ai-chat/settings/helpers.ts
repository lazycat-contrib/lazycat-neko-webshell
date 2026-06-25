import type { AiMcpServerSettings, AiProviderProfile } from "../../../types";
import type { Translate } from "./types";

export function aiProviderLabel(provider: string, tr: Translate): string {
  if (provider === "openai-responses") return tr("ai.providerOpenAIResponses");
  if (provider === "anthropic") return tr("ai.providerAnthropic");
  return tr("ai.providerOpenAICompatible");
}

export function activeAiProviderProfile(profiles: AiProviderProfile[], activeProfileId: string): AiProviderProfile | undefined {
  return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
}

export function emptyAiProviderProfile(): AiProviderProfile {
  return {
    id: "",
    name: "",
    provider: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
  };
}

export function mcpTransportLabel(transport: AiMcpServerSettings["transport"], tr: Translate): string {
  return transport === "sse" ? tr("mcp.transportSse") : tr("mcp.transportHttp");
}
