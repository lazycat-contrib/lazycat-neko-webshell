import type { MessageKey } from "../../../i18n";
import type {
  AiMcpServerSettings,
  AiProviderProfile,
  AiVoiceProviderProfile,
  AiVoiceSpeechProviderProfile,
} from "../../../types";

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
  voiceInputEnabled: boolean;
  voiceProfiles: AiVoiceProviderProfile[];
  activeVoiceProfileId: string;
  voiceReplyEnabled: boolean;
  voiceReplyProfiles: AiVoiceSpeechProviderProfile[];
  activeVoiceReplyProfileId: string;
  activeTab: "ai" | "mcp" | "voice";
  dialog: AIConfigDialogViewState | undefined;
};

export type AIConfigDialogViewState =
  | { type: "ai"; profile: AiProviderProfile; isNew: boolean }
  | { type: "mcp"; index: number; server: AiMcpServerSettings; headersText: string }
  | { type: "voice"; profile: AiVoiceProviderProfile; isNew: boolean }
  | { type: "voice-reply"; profile: AiVoiceSpeechProviderProfile; isNew: boolean };

export type AIAccessSettingsRenderState = AIAccessSettingsViewState & {
  disabled: boolean;
  tr: Translate;
};
