import type { ResttyFontSource } from "restty";
import type { Terminal } from "restty/xterm";

export type Tone = "ok" | "error" | "neutral";
export type TabLayout = "horizontal" | "vertical";
export type CursorShape = "block" | "bar" | "underline";
export type SplitPlacement = "up" | "down" | "left" | "right";
export type SplitAxis = "rows" | "columns";
export type LocaleSetting = "auto" | "en" | "zh-CN";
export type TouchSelectionMode = "long-press" | "drag" | "off";
export type InterfaceStyleId = "steel" | "glass" | "brass" | "spectrum" | "geek";

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

export type WorkspacePaneState = {
  id: string;
  session_id: string;
  status: string;
  cols: number;
  rows: number;
};

export type WorkspaceTabState = {
  id: string;
  label: string;
  custom_label?: string;
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
  | "update_layout";

export type HerdrWorkspaceInfo = {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  active_tab_id: string;
  tab_count: number;
  pane_count: number;
};

export type HerdrTabInfo = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
};

export type HerdrBridgeState = {
  selector: string;
  available: boolean;
  message?: string;
  workspaces: HerdrWorkspaceInfo[];
  tabs: HerdrTabInfo[];
};

export type HerdrAction = "focus_workspace" | "focus_tab" | "create_tab";

export type SessionBackendId = "webshell" | "herdr" | "zellij";

export type SessionBackendInfo = {
  id: SessionBackendId;
  label: string;
  available: boolean;
};

export type SessionBackendsState = {
  selector: string;
  backends: SessionBackendInfo[];
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
  resttySources?: ResttyFontSource[];
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
  cursorBlink: boolean;
  cursorShape: CursorShape;
  copyOnSelect: boolean;
  useResttyClipboard: boolean;
  touchSelectionMode: TouchSelectionMode;
  terminalBackgroundEnabled: boolean;
  terminalBackgroundUrl: string;
  terminalBackgroundOpacity: number;
  terminalBackgroundBlur: number;
  scrollbackLimit: number;
  outputBufferLimit: number;
  autoRestartSessions: boolean;
  debugMode: boolean;
  aiProvider: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
};

export type TerminalPane = {
  id: string;
  tabId: string;
  selector: string;
  label: string;
  title: string;
  status: string;
  tone: Tone;
  mount: HTMLDivElement;
  sessionId?: string;
  sessionStatus?: string;
  term?: Terminal;
  socket?: WebSocket;
  transport?: PaneTerminalTransport;
  decoder?: TextDecoder;
  titleBuffer: string;
  reconnectTimer?: number;
  replayTimer?: number;
  reconnectDelay: number;
  pendingInput: string[];
  pendingInputBytes: number;
  replaying: boolean;
  lastOutputSequence: number;
  viewportGuardInstalled?: boolean;
  exited: boolean;
  closing: boolean;
  cols: number;
  rows: number;
};

export type TerminalTab = {
  id: string;
  selector: string;
  label: string;
  customTitle?: string;
  mount: HTMLDivElement;
  panes: TerminalPane[];
  activePaneId?: string;
  layout?: SplitNode;
  closing: boolean;
};
