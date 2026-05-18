import type { ResttyFontSource } from "restty";
import type { Terminal } from "restty/xterm";

import type { Session } from "./gen/lazycat/webshell/v1/capability_pb";

export type Tone = "ok" | "error" | "neutral";
export type TabLayout = "horizontal" | "vertical";
export type CursorShape = "block" | "bar" | "underline";
export type SplitPlacement = "up" | "down" | "left" | "right";
export type SplitAxis = "rows" | "columns";
export type LocaleSetting = "auto" | "en" | "zh-CN";
export type TouchSelectionMode = "long-press" | "drag" | "off";

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
  session?: Session;
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
