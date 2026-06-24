import type { FontPreset, InterfaceStyleId, Settings, TerminalTheme } from "./types";

export const INITIAL_COLS = 120;
export const INITIAL_ROWS = 32;
export const STATUS_REFRESH_MS = 700;
export const MAX_FONT_BYTES = 10 * 1024 * 1024;
export const MAX_TERMINAL_BACKGROUND_BYTES = 10 * 1024 * 1024;
export const MAX_CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;
export const PREINSTALLED_FONT_BASE = "./fonts/preinstalled/";
export const MIN_OUTPUT_BUFFER_LIMIT = 128;
export const MAX_OUTPUT_BUFFER_LIMIT = 20000;
export const MAX_CUSTOM_THEME_SOURCE_BYTES = 64 * 1024;

export const FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf"];
export const TERMINAL_BACKGROUND_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

export const FONT_MIME_TYPES = new Set([
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/octet-stream",
]);

export const TERMINAL_BACKGROUND_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/octet-stream",
]);

export const INTERFACE_STYLE_IDS: InterfaceStyleId[] = [
  "steel",
  "glass",
  "brass",
  "spectrum",
  "geek",
  "porcelain",
  "frost",
  "champagne",
  "candy",
  "lab",
];

export const THEMES: TerminalTheme[] = [
  { id: "ghostty", label: "Ghostty Default", ghosttyName: "Ghostty Default Style Dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", ghosttyName: "Catppuccin Mocha", className: "theme-catppuccin-mocha" },
  { id: "tokyo-night", label: "TokyoNight Night", ghosttyName: "TokyoNight Night", className: "theme-tokyo-night" },
  { id: "tokyo-night-storm", label: "TokyoNight Storm", ghosttyName: "TokyoNight Storm" },
  { id: "kanagawa-wave", label: "Kanagawa Wave", ghosttyName: "Kanagawa Wave" },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon", ghosttyName: "Kanagawa Dragon" },
  { id: "rose-pine", label: "Rose Pine", ghosttyName: "Rose Pine" },
  { id: "rose-pine-moon", label: "Rose Pine Moon", ghosttyName: "Rose Pine Moon" },
  { id: "ayu-mirage", label: "Ayu Mirage", ghosttyName: "Ayu Mirage" },
  { id: "nord", label: "Nord", ghosttyName: "Nord", className: "theme-nord" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", ghosttyName: "Gruvbox Dark", className: "theme-gruvbox-dark" },
  { id: "gruvbox-material-dark", label: "Gruvbox Material Dark", ghosttyName: "Gruvbox Material Dark" },
  { id: "everforest-dark", label: "Everforest Dark", ghosttyName: "Everforest Dark Hard" },
  { id: "dracula", label: "Dracula", ghosttyName: "Dracula", className: "theme-dracula" },
  { id: "one-dark", label: "One Dark", ghosttyName: "One Dark Two", className: "theme-one-dark" },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    ghosttyName: "iTerm2 Solarized Dark",
    className: "theme-solarized-dark",
  },
  { id: "github-dark", label: "GitHub Dark", ghosttyName: "GitHub Dark", className: "theme-github-dark" },
  { id: "monokai", label: "Monokai", ghosttyName: "Monokai Classic", className: "theme-monokai" },
  { id: "light", label: "Classic Light", ghosttyName: "Builtin Light", className: "theme-light" },
];

export const SYMBOLS_SOURCE = {
  type: "url" as const,
  url: `${PREINSTALLED_FONT_BASE}SymbolsNerdFontMono-Regular.ttf`,
  label: "Symbols Nerd Font Mono",
};

export const CJK_FONT_SOURCE = {
  type: "url" as const,
  url: `${PREINSTALLED_FONT_BASE}MapleMono-NF-CN-Regular.ttf`,
  label: "Maple Mono NF CN Regular",
};

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "system-mono",
    label: "System Mono",
    family: "\"SFMono-Regular\", \"Cascadia Mono\", \"Consolas\", \"Liberation Mono\", monospace",
    resttySources: [
      { type: "url", url: `${PREINSTALLED_FONT_BASE}Hack-Regular.woff2`, label: "Hack Regular" },
      SYMBOLS_SOURCE,
    ],
  },
  {
    id: "jetbrains",
    label: "Hack",
    family: "\"Hack\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
    resttySources: [
      { type: "url", url: `${PREINSTALLED_FONT_BASE}Hack-Regular.woff2`, label: "Hack Regular" },
      SYMBOLS_SOURCE,
    ],
  },
  {
    id: "ibm-plex",
    label: "Source Code Pro",
    family: "\"Source Code Pro\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
    resttySources: [
      { type: "url", url: `${PREINSTALLED_FONT_BASE}SourceCodePro-Regular.ttf`, label: "Source Code Pro Regular" },
      SYMBOLS_SOURCE,
    ],
  },
  {
    id: "fira-code",
    label: "Fira Code",
    family: "\"Fira Code\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
    resttySources: [
      { type: "url", url: `${PREINSTALLED_FONT_BASE}FiraCode-Regular.ttf`, label: "Fira Code Regular" },
      SYMBOLS_SOURCE,
    ],
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro Alt",
    family: "\"Source Code Pro\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
    resttySources: [
      { type: "url", url: `${PREINSTALLED_FONT_BASE}SourceCodePro-Regular.ttf`, label: "Source Code Pro Regular" },
      SYMBOLS_SOURCE,
    ],
  },
  {
    id: "ui-monospace",
    label: "UI Monospace",
    family: "ui-monospace, \"SFMono-Regular\", \"Menlo\", \"Consolas\", monospace",
    resttySources: [
      { type: "url", url: `${PREINSTALLED_FONT_BASE}Hack-Regular.woff2`, label: "Hack Regular" },
      SYMBOLS_SOURCE,
    ],
  },
];

export const DEFAULT_SETTINGS: Settings = {
  locale: "auto",
  themeId: "catppuccin-mocha",
  interfaceStyleId: "steel",
  customThemes: [],
  fontFamilyId: "system-mono",
  tabLayout: "horizontal",
  fontSize: 14,
  lineHeight: 1.22,
  fontLigatures: true,
  fontHinting: false,
  fontHintTarget: "auto",
  cursorBlink: true,
  cursorShape: "block",
  copyOnSelect: false,
  useResttyClipboard: true,
  touchSelectionMode: "long-press",
  mobileClockUse24Hour: true,
  mobileClockShowPeriod: false,
  terminalBackgroundEnabled: false,
  terminalBackgroundUrl: "",
  terminalBackgroundOpacity: 0.24,
  terminalBackgroundBlur: 0,
  terminalShaderEffect: "off",
  scrollbackLimit: 10000,
  outputBufferLimit: 4096,
  defaultSessionBackend: "webshell",
  herdrActiveBackgroundDark: "#06193a",
  herdrActiveBackgroundLight: "#f0f7ff",
  autoRestartSessions: false,
  debugMode: false,
  aiProvider: "openai-compatible",
  aiBaseUrl: "",
  aiApiKey: "",
  aiModel: "",
  aiProviderProfiles: [],
  aiActiveProviderProfileId: "",
  aiMcpServers: "",
  mobileQuickPhrases: [],
};
