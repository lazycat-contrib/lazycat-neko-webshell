export type AISettingsTab = "ai" | "mcp" | "voice";

export type AIConfigDialogState =
  | { type: "ai"; profileId?: string; isNew?: boolean }
  | { type: "mcp"; index: number }
  | { type: "voice"; profileId?: string; isNew?: boolean }
  | { type: "voice-reply"; profileId?: string; isNew?: boolean };

export function normalizeAISettingsTab(value: string | undefined): AISettingsTab {
  return value === "mcp" || value === "voice" ? value : "ai";
}

export function normalizeAIConfigDialogType(value: string | undefined): AIConfigDialogState["type"] {
  if (value === "mcp" || value === "voice" || value === "voice-reply") return value;
  return "ai";
}
