import { DEFAULT_SETTINGS, INTERFACE_STYLE_IDS, MAX_CUSTOM_THEME_SOURCE_BYTES, MAX_OUTPUT_BUFFER_LIMIT, MIN_OUTPUT_BUFFER_LIMIT } from "../config";
import type { AiProviderProfile, CustomTerminalTheme, InterfaceStyleId, SessionBackendId, Settings } from "../types";
import { clampNumber } from "../utils";

export function migrateSettings(value: Partial<Settings>): Settings {
  const terminalBackgroundUrl = normalizeTerminalBackgroundUrl(value.terminalBackgroundUrl);
  const legacyProvider = normalizeAiProvider(value.aiProvider);
  const legacyProfile: AiProviderProfile = {
    id: "default",
    name: "Default",
    provider: legacyProvider,
    baseUrl: typeof value.aiBaseUrl === "string" ? value.aiBaseUrl : DEFAULT_SETTINGS.aiBaseUrl,
    apiKey: typeof value.aiApiKey === "string" ? value.aiApiKey : DEFAULT_SETTINGS.aiApiKey,
    model: typeof value.aiModel === "string" ? value.aiModel : DEFAULT_SETTINGS.aiModel,
  };
  const aiProviderProfiles = normalizeAiProviderProfiles(value.aiProviderProfiles, legacyProfile);
  const aiActiveProviderProfileId = normalizeActiveAiProviderProfileId(
    value.aiActiveProviderProfileId,
    aiProviderProfiles,
  );
  const activeAiProfile = aiProviderProfiles.find((profile) => profile.id === aiActiveProviderProfileId);

  return {
    locale: value.locale === "en" || value.locale === "zh-CN" ? value.locale : DEFAULT_SETTINGS.locale,
    themeId: typeof value.themeId === "string" ? value.themeId : DEFAULT_SETTINGS.themeId,
    interfaceStyleId: normalizeInterfaceStyleId(value.interfaceStyleId),
    customThemes: normalizeCustomThemes(value.customThemes),
    fontFamilyId: typeof value.fontFamilyId === "string" ? value.fontFamilyId : DEFAULT_SETTINGS.fontFamilyId,
    fontSize: clampNumber(value.fontSize, 11, 22, DEFAULT_SETTINGS.fontSize),
    lineHeight: clampNumber(value.lineHeight, 1.05, 1.6, DEFAULT_SETTINGS.lineHeight),
    cursorBlink: value.cursorBlink ?? DEFAULT_SETTINGS.cursorBlink,
    cursorShape: value.cursorShape === "bar" || value.cursorShape === "underline" ? value.cursorShape : "block",
    copyOnSelect: value.copyOnSelect ?? DEFAULT_SETTINGS.copyOnSelect,
    useResttyClipboard: value.useResttyClipboard ?? DEFAULT_SETTINGS.useResttyClipboard,
    touchSelectionMode: normalizeTouchSelectionMode(value.touchSelectionMode),
    terminalBackgroundEnabled: terminalBackgroundUrl
      ? value.terminalBackgroundEnabled ?? DEFAULT_SETTINGS.terminalBackgroundEnabled
      : false,
    terminalBackgroundUrl,
    terminalBackgroundOpacity: clampNumber(
      value.terminalBackgroundOpacity,
      0.05,
      0.8,
      DEFAULT_SETTINGS.terminalBackgroundOpacity,
    ),
    terminalBackgroundBlur: Math.round(
      clampNumber(value.terminalBackgroundBlur, 0, 24, DEFAULT_SETTINGS.terminalBackgroundBlur),
    ),
    scrollbackLimit: Math.round(
      clampNumber(value.scrollbackLimit, 1000, 100000, DEFAULT_SETTINGS.scrollbackLimit),
    ),
    outputBufferLimit: Math.round(
      clampNumber(value.outputBufferLimit, MIN_OUTPUT_BUFFER_LIMIT, MAX_OUTPUT_BUFFER_LIMIT, DEFAULT_SETTINGS.outputBufferLimit),
    ),
    defaultSessionBackend: normalizeSessionBackendId(value.defaultSessionBackend),
    herdrActiveBackgroundDark: normalizeHexColor(
      value.herdrActiveBackgroundDark,
      DEFAULT_SETTINGS.herdrActiveBackgroundDark,
    ),
    herdrActiveBackgroundLight: normalizeHexColor(
      value.herdrActiveBackgroundLight,
      DEFAULT_SETTINGS.herdrActiveBackgroundLight,
    ),
    autoRestartSessions: value.autoRestartSessions ?? DEFAULT_SETTINGS.autoRestartSessions,
    tabLayout: value.tabLayout === "vertical" ? "vertical" : DEFAULT_SETTINGS.tabLayout,
    debugMode: value.debugMode ?? DEFAULT_SETTINGS.debugMode,
    aiProvider: activeAiProfile?.provider ?? legacyProfile.provider,
    aiBaseUrl: activeAiProfile?.baseUrl ?? legacyProfile.baseUrl,
    aiApiKey: activeAiProfile?.apiKey ?? legacyProfile.apiKey,
    aiModel: activeAiProfile?.model ?? legacyProfile.model,
    aiProviderProfiles,
    aiActiveProviderProfileId,
    aiMcpServers: typeof value.aiMcpServers === "string" ? value.aiMcpServers : DEFAULT_SETTINGS.aiMcpServers,
    aiSendTerminalContext: value.aiSendTerminalContext ?? DEFAULT_SETTINGS.aiSendTerminalContext,
    aiContextLines: Math.round(clampNumber(value.aiContextLines, 0, 200, DEFAULT_SETTINGS.aiContextLines)),
  };
}

function normalizeAiProvider(value: unknown): string {
  return value === "openai-responses" || value === "anthropic"
    ? value
    : DEFAULT_SETTINGS.aiProvider;
}

function normalizeAiProviderProfiles(value: unknown, legacyProfile: AiProviderProfile): AiProviderProfile[] {
  const source = Array.isArray(value) ? value : [];
  const profiles: AiProviderProfile[] = [];
  const ids = new Set<string>();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const profile = item as Partial<AiProviderProfile>;
    const id = normalizeAiProfileId(profile.id, ids, profiles.length);
    const name = typeof profile.name === "string" && profile.name.trim()
      ? profile.name.trim().slice(0, 48)
      : `Provider ${profiles.length + 1}`;
    profiles.push({
      id,
      name,
      provider: normalizeAiProvider(profile.provider),
      baseUrl: typeof profile.baseUrl === "string" ? profile.baseUrl : "",
      apiKey: typeof profile.apiKey === "string" ? profile.apiKey : "",
      model: typeof profile.model === "string" ? profile.model : "",
    });
    ids.add(id);
  }
  if (!profiles.length && legacyAiProfileHasData(legacyProfile)) {
    profiles.push(legacyProfile);
  }
  return profiles.slice(0, 12);
}

function normalizeAiProfileId(value: unknown, used: Set<string>, index: number): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  const sanitized = candidate.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  if (sanitized && !used.has(sanitized)) return sanitized;
  let fallback = index === 0 ? "default" : `provider-${index + 1}`;
  let suffix = 2;
  while (used.has(fallback)) {
    fallback = `provider-${index + suffix}`;
    suffix += 1;
  }
  return fallback;
}

function legacyAiProfileHasData(profile: AiProviderProfile): boolean {
  return Boolean(profile.baseUrl.trim() || profile.apiKey.trim() || profile.model.trim());
}

function normalizeActiveAiProviderProfileId(value: unknown, profiles: AiProviderProfile[]): string {
  const id = typeof value === "string" ? value : "";
  if (profiles.some((profile) => profile.id === id)) return id;
  return profiles[0]?.id ?? "";
}

function normalizeSessionBackendId(value: unknown): SessionBackendId {
  return value === "herdr" || value === "zellij" ? value : DEFAULT_SETTINGS.defaultSessionBackend;
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function normalizeInterfaceStyleId(value: unknown): InterfaceStyleId {
  return INTERFACE_STYLE_IDS.includes(value as InterfaceStyleId)
    ? value as InterfaceStyleId
    : DEFAULT_SETTINGS.interfaceStyleId;
}

function normalizeTerminalBackgroundUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\r\n"'\\]/.test(trimmed)) return "";
  try {
    const url = new URL(trimmed, window.location.href);
    if (url.origin !== window.location.origin) return "";
    if (!/^\/api\/terminal-backgrounds\/[0-9a-f-]+\/file$/.test(url.pathname)) return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function normalizeTouchSelectionMode(value: unknown): Settings["touchSelectionMode"] {
  return value === "drag" || value === "off" || value === "long-press"
    ? value
    : DEFAULT_SETTINGS.touchSelectionMode;
}

function normalizeCustomThemes(value: unknown): CustomTerminalTheme[] {
  if (!Array.isArray(value)) return [];
  const themes: CustomTerminalTheme[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const theme = item as Partial<CustomTerminalTheme>;
    const id = typeof theme.id === "string" ? theme.id.trim() : "";
    const label = typeof theme.label === "string" ? theme.label.trim() : "";
    const source = typeof theme.ghosttySource === "string" ? theme.ghosttySource.slice(0, MAX_CUSTOM_THEME_SOURCE_BYTES) : "";
    if (!id || !label || !source || seen.has(id)) continue;
    seen.add(id);
    themes.push({ id, label, ghosttySource: source });
  }
  return themes;
}
