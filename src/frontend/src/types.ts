import type { ResttyFontInput } from "restty";
import type { Terminal } from "restty/xterm";
import type { TerminalReplyAuthority } from "./terminal-reply-authority";

export type Tone = "ok" | "error" | "neutral";
export type TabLayout = "horizontal" | "vertical";
export type CursorShape = "block" | "bar" | "underline";
export type SplitPlacement = "up" | "down" | "left" | "right";
export type SplitAxis = "rows" | "columns";
export type LocaleSetting = "auto" | "en" | "zh-CN";
export type TouchSelectionMode = "long-press" | "drag" | "off";
export type TerminalShaderEffect = "off" | "interactive-glow" | "soft-vignette" | "scanline";
export type TerminalFontHintTarget = "auto" | "light" | "normal";
export type InterfaceStyleId =
  | "steel"
  | "glass"
  | "brass"
  | "spectrum"
  | "geek"
  | "porcelain"
  | "frost"
  | "champagne"
  | "candy"
  | "lab";

export type SplitPaneNode = {
  type: "pane";
  paneId: string;
};

export type SplitContainerNode = {
  type: "split";
  axis: SplitAxis;
  children: SplitNode[];
};

export type SplitNode = SplitPaneNode | SplitContainerNode;

export type RemoteProgramKind = "herdr";

export type WorkspacePaneState = {
  id: string;
  session_id: string;
  status: string;
  session_backend?: SessionBackendId;
  terminal_reply_authority?: TerminalReplyAuthority | string;
  program_kind?: RemoteProgramKind;
  herdr_output_sequence?: number;
  cols: number;
  rows: number;
};

export type WorkspaceTabState = {
  id: string;
  label: string;
  custom_label?: string;
  pinned?: boolean;
  pinned_order?: number;
  active_pane_id?: string;
  layout?: SplitNode;
  panes: WorkspacePaneState[];
};

export type WorkspaceState = {
  selector: string;
  active_tab_id?: string;
  tabs: WorkspaceTabState[];
};

export type WorkspaceAction =
  | "create_tab"
  | "close_tab"
  | "rename_tab"
  | "activate_tab"
  | "split_pane"
  | "close_pane"
  | "activate_pane"
  | "promote_pane_to_tab"
  | "update_layout"
  | "set_tab_pinned";

export type HerdrMetadataTokens = Record<string, string>;

export type HerdrWorkspaceInfo = {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  active_tab_id: string;
  tab_count: number;
  pane_count: number;
  tokens: HerdrMetadataTokens;
};

export type HerdrTabInfo = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
};

export type HerdrCapabilitiesInfo = {
  live_handoff: boolean;
  detached_server_daemon: boolean;
};

export type HerdrPaneInfo = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  title?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  display_agent?: string;
  agent?: string;
  agent_status: string;
  tokens: HerdrMetadataTokens;
};

export type HerdrAgentInfo = {
  terminal_id: string;
  name?: string;
  agent?: string;
  display_agent?: string;
  agent_status: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  revision: number;
  launch_pending: boolean;
  interactive_ready: boolean;
  state_change_seq: number;
  title?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  tokens: HerdrMetadataTokens;
};

export type HerdrBridgeState = {
  selector: string;
  available: boolean;
  resources_complete: boolean;
  message?: string;
  herdr_version?: string;
  herdr_protocol?: number;
  supported_herdr_version: string;
  supported_protocol: number;
  socket_schema_version: number;
  socket_source_revision: string;
  protocol_compatible?: boolean;
  capabilities?: HerdrCapabilitiesInfo;
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
  workspaces: HerdrWorkspaceInfo[];
  tabs: HerdrTabInfo[];
  panes: HerdrPaneInfo[];
  agents: HerdrAgentInfo[];
};

export type HerdrRuntimeGuardState = {
  selector: string;
  state: "not_running" | "ready" | "unknown" | "client_older" | "server_older";
  client_version: string;
  client_protocol: number;
  server_version?: string;
  server_protocol?: number;
  live_handoff_available: boolean;
  handoff_recent?: boolean;
};

export type HerdrAction = "focus_workspace" | "focus_tab" | "focus_pane" | "create_tab" | "close_workspace" | "create_workspace";

export type SessionBackendId = "webshell" | "herdr" | "zellij" | "ssh";

export type SessionBackendInfo = {
  id: SessionBackendId;
  label: string;
  available: boolean;
  supports_terminal_transfer?: boolean;
  supportsTerminalTransfer?: boolean;
  lightos_only?: boolean;
  lightosOnly?: boolean;
};

export type SessionBackendsState = {
  selector: string;
  backends: SessionBackendInfo[];
};

export type FileBrowserEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "hardlink" | "other";
  size: number;
  linkTarget?: string;
};

export type FileBrowserContextMenu = {
  path: string;
  x: number;
  y: number;
};

export type AIChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  tone?: Tone;
};

export type AIChatSession = {
  id: string;
  model: string;
  title: string;
  terminalTargetKey?: string;
  terminalTargetLabel?: string;
  sendTerminalContext: boolean;
  messages: AIChatMessage[];
};

export type AIChatTerminalTarget = {
  key: string;
  label: string;
  herdrAgent?: {
    target: string;
    label: string;
    status: string;
    interactiveReady: boolean;
  };
};

export type AiMcpServerSettings = {
  name: string;
  url: string;
  transport: "streamable-http" | "sse";
  authorization: string;
  headers: Record<string, string>;
};

export type AiProviderProfile = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type AiVoiceProviderKind = "mimo" | "mimo-token-plan" | "openai-compatible";
export type AiVoiceEndpointType = "audio-transcriptions" | "chat-input-audio";
export type AiVoiceInputFormat = "auto" | "wav" | "webm-opus" | "webm" | "mp4" | "m4a" | "mp3" | "mpeg" | "mpga";
export type AiVoiceSpeechEndpointType = "audio-speech" | "chat-audio";

export type AiVoiceProviderProfile = {
  id: string;
  name: string;
  provider: AiVoiceProviderKind;
  endpointType: AiVoiceEndpointType;
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
  format: AiVoiceInputFormat;
};

export type AiVoiceSpeechProviderProfile = {
  id: string;
  name: string;
  provider: AiVoiceProviderKind;
  endpointType: AiVoiceSpeechEndpointType;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  format: string;
  instructions: string;
};

export type MobileQuickPhrase = {
  id: string;
  label: string;
  text: string;
  useCount: number;
  lastUsedAt: number;
};

export type ClipboardImagePayload = {
  extension: string;
  data: ArrayBuffer;
};

export type JsonRecord = Record<string, unknown>;

export type HerdrSocketEnvelope = {
  id?: string;
  result?: JsonRecord;
  error?: {
    code?: string;
    message?: string;
  };
  event?: string;
  data?: JsonRecord;
};

export type TerminalTheme = {
  id: string;
  label: string;
  ghosttyName?: string;
  ghosttySource?: string;
  className?: string;
  custom?: boolean;
};

export type CustomTerminalTheme = {
  id: string;
  label: string;
  ghosttySource: string;
};

export type FontPreset = {
  id: string;
  label: string;
  family: string;
  resttySources?: ResttyFontInput[];
  custom?: boolean;
};

export type StoredFont = {
  id: string;
  label: string;
  family: string;
  mimeType?: string;
  size: number;
  url: string;
};

export type TerminalBackground = {
  id: string;
  mimeType: string;
  size: number;
  url: string;
};

export type TerminalTransport = {
  connect: (options: {
    url: string;
    cols?: number;
    rows?: number;
    callbacks: {
      onConnect?: () => void;
      onDisconnect?: () => void;
      onData?: (data: string) => void;
      onStatus?: (shell: string) => void;
      onError?: (message: string, errors?: string[]) => void;
      onExit?: (code: number) => void;
    };
  }) => void;
  disconnect: () => void;
  sendInput: (data: string) => boolean;
  resize: (cols: number, rows: number, meta?: unknown) => boolean;
  isConnected: () => boolean;
  destroy: () => void;
};

export type PaneTerminalTransport = TerminalTransport & {
  notifyConnect: () => void;
  notifyDisconnect: () => void;
  notifyData: (data: string) => boolean;
  notifyError: (message: string, errors?: string[]) => void;
  notifyExit: (code: number) => void;
};

export type Settings = {
  locale: LocaleSetting;
  themeId: string;
  interfaceStyleId: InterfaceStyleId;
  customThemes: CustomTerminalTheme[];
  fontFamilyId: string;
  tabLayout: TabLayout;
  fontSize: number;
  lineHeight: number;
  fontLigatures: boolean;
  fontHinting: boolean;
  fontHintTarget: TerminalFontHintTarget;
  cursorBlink: boolean;
  cursorShape: CursorShape;
  copyOnSelect: boolean;
  useResttyClipboard: boolean;
  touchSelectionMode: TouchSelectionMode;
  preventMobileKeyboardAutoOpen: boolean;
  mobileClockEnabled: boolean;
  mobileClockUse24Hour: boolean;
  mobileClockShowPeriod: boolean;
  terminalBackgroundEnabled: boolean;
  terminalBackgroundUrl: string;
  terminalBackgroundOpacity: number;
  terminalBackgroundBlur: number;
  terminalShaderEffect: TerminalShaderEffect;
  scrollbackLimit: number;
  outputBufferLimit: number;
  sshConfigBackupLimit: number;
  defaultSessionBackend: SessionBackendId;
  terminalSingleControllerMode: boolean;
  terminalBlurObservers: boolean;
  herdrLazycatNotifications: boolean;
  herdrActiveBackgroundDark: string;
  herdrActiveBackgroundLight: string;
  autoRestartSessions: boolean;
  debugMode: boolean;
  aiProvider: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiProviderProfiles: AiProviderProfile[];
  aiActiveProviderProfileId: string;
  aiMcpServers: string;
  aiVoiceInputEnabled: boolean;
  aiVoiceProviderProfiles: AiVoiceProviderProfile[];
  aiVoiceActiveProviderProfileId: string;
  aiVoiceReplyEnabled: boolean;
  aiVoiceReplyProviderProfiles: AiVoiceSpeechProviderProfile[];
  aiVoiceReplyActiveProviderProfileId: string;
  mobileQuickPhrases: MobileQuickPhrase[];
};

export type TerminalPane = {
  id: string;
  workspacePaneId: string;
  programKind?: RemoteProgramKind;
  tabId: string;
  selector: string;
  label: string;
  title: string;
  status: string;
  tone: Tone;
  mount: HTMLDivElement;
  sessionId?: string;
  sessionStatus?: string;
  sessionBackend: SessionBackendId;
  terminalReplyAuthority: TerminalReplyAuthority;
  workingDirectory?: string;
  term?: Terminal;
  terminalCanvas?: HTMLCanvasElement;
  terminalImeInput?: HTMLTextAreaElement;
  socket?: WebSocket;
  remoteKeepaliveStop?: () => void;
  transport?: PaneTerminalTransport;
  decoder?: TextDecoder;
  titleBuffer: string;
  reconnectTimer?: number;
  replayTimer?: number;
  reconnectDelay: number;
  processExitObserved?: boolean;
  pendingInput: string[];
  pendingInputBytes: number;
  replaying: boolean;
  allowGeneratedInputDuringReplay: boolean;
  lastReplayAfter?: number;
  lastOutputSequence: number;
  aiContextText: string;
  serverCols: number;
  serverRows: number;
  localCols: number;
  localRows: number;
  terminalShaderEffect?: TerminalShaderEffect;
  viewportGuardInstalled?: boolean;
  scrollbackFallbackInstalled?: boolean;
  touchKeyboardGuardInstalled?: boolean;
  touchKeyboardGuardDispose?: () => void;
  exited: boolean;
  closing: boolean;
  cols: number;
  rows: number;
};

export type TerminalTab = {
  id: string;
  workspaceTabId: string;
  selector: string;
  label: string;
  customTitle?: string;
  mount: HTMLDivElement;
  panes: TerminalPane[];
  activePaneId?: string;
  layout?: SplitNode;
  pinned: boolean;
  pinnedOrder?: number;
  closing: boolean;
};
