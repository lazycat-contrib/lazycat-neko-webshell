import {
  XIAOMI_MIMO_API_BASE,
  XIAOMI_MIMO_MODEL,
  XIAOMI_MIMO_TOKEN_PLAN_API_BASE,
} from "../voice-profiles";

export function applyVoiceProviderDialogPreset(root: ParentNode, provider: string) {
  const endpoint = dialogSelect(root, "voiceEndpointType");
  const format = dialogSelect(root, "voiceFormat");
  const baseUrl = dialogInput(root, "voiceBaseUrl");
  const model = dialogInput(root, "voiceModel");
  const language = dialogInput(root, "voiceLanguage");
  const isMimo = provider === "mimo" || provider === "mimo-token-plan";

  if (endpoint) {
    endpoint.disabled = isMimo;
    if (isMimo) endpoint.value = "chat-input-audio";
  }
  if (format) {
    format.disabled = isMimo;
    if (isMimo) format.value = "wav";
    if (!isMimo && !format.value) format.value = "auto";
  }
  if (provider === "mimo") {
    if (baseUrl) baseUrl.value = XIAOMI_MIMO_API_BASE;
    if (model) model.value = XIAOMI_MIMO_MODEL;
    if (language) language.value = "zh";
    return;
  }
  if (provider === "mimo-token-plan") {
    if (baseUrl) baseUrl.value = XIAOMI_MIMO_TOKEN_PLAN_API_BASE;
    if (model) model.value = XIAOMI_MIMO_MODEL;
    if (language) language.value = "zh";
  }
}

function dialogSelect(root: ParentNode, field: string): HTMLSelectElement | null {
  return root.querySelector<HTMLSelectElement>(`[data-ai-dialog-field="${field}"]`);
}

function dialogInput(root: ParentNode, field: string): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(`[data-ai-dialog-field="${field}"]`);
}
