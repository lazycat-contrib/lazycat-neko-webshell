import type { MessageKey } from "../../../i18n";
import type { AiMcpServerSettings, AiProviderProfile } from "../../../types";

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type AIAccessSettingsViewState = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelOptions: string[];
  profiles: AiProviderProfile[];
  activeProfileId: string;
  mcpServers: AiMcpServerSettings[];
  activeTab: "ai" | "mcp";
  dialog: AIConfigDialogViewState | undefined;
};

export type AIConfigDialogViewState =
  | { type: "ai"; profile: AiProviderProfile; isNew: boolean }
  | { type: "mcp"; index: number; server: AiMcpServerSettings; headersText: string };

export type AIAccessSettingsRenderState = AIAccessSettingsViewState & {
  disabled: boolean;
  tr: Translate;
};
