import type { Instance } from "./gen/lazycat/webshell/v1/capability_pb";
import type {
  HerdrAction,
  HerdrBridgeState,
  HerdrSocketEnvelope,
  JsonRecord,
  SessionBackendsState,
  SessionBackendId,
  SplitNode,
  SplitPlacement,
  WorkspaceAction,
  WorkspaceState,
} from "./types";

export type WorkspaceRequestOptions = {
  cols: number;
  rows: number;
  outputLimit: number;
  autoRestart: boolean;
  selectRunningInstanceMessage: string;
};

export type WorkspaceActionRequestOptions = {
  selector: string;
  cols: number;
  rows: number;
  outputLimit: number;
  autoRestart: boolean;
  tabId?: string;
  paneId?: string;
  direction?: SplitPlacement;
  label?: string;
  layout?: SplitNode;
  activePaneId?: string;
  sessionBackend?: SessionBackendId;
};

export async function fetchInstances(): Promise<Instance[]> {
  const response = await fetch(new URL("./api/instances", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  await throwIfFailed(response);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("invalid instances response");
  }
  return payload as Instance[];
}

export async function fetchWorkspace(
  selector: string,
  options: WorkspaceRequestOptions,
): Promise<WorkspaceState> {
  if (!selector) {
    throw new Error(options.selectRunningInstanceMessage);
  }
  const url = new URL("./api/workspace", window.location.href);
  url.searchParams.set("name", selector);
  url.searchParams.set("cols", String(options.cols));
  url.searchParams.set("rows", String(options.rows));
  url.searchParams.set("output_limit", String(options.outputLimit));
  url.searchParams.set("auto_restart", String(options.autoRestart));
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  await throwIfFailed(response);
  return response.json() as Promise<WorkspaceState>;
}

export async function runWorkspaceActionRequest(
  action: WorkspaceAction,
  options: WorkspaceActionRequestOptions,
): Promise<WorkspaceState> {
  const response = await fetch(new URL("./api/workspace", window.location.href), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: options.selector,
      action,
      tab_id: options.tabId,
      pane_id: options.paneId,
      direction: options.direction,
      label: options.label,
      layout: options.layout,
      active_pane_id: options.activePaneId,
      cols: options.cols,
      rows: options.rows,
      output_limit: options.outputLimit,
      auto_restart: options.autoRestart,
      session_backend: options.sessionBackend,
    }),
  });
  await throwIfFailed(response);
  return response.json() as Promise<WorkspaceState>;
}

export async function fetchSessionBackends(selector: string): Promise<SessionBackendsState> {
  const url = new URL("./api/session-backends", window.location.href);
  url.searchParams.set("name", selector);
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  await throwIfFailed(response);
  return response.json() as Promise<SessionBackendsState>;
}

export async function fetchHerdrState(selector: string): Promise<HerdrBridgeState> {
  const url = new URL("./api/herdr", window.location.href);
  url.searchParams.set("name", selector);
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  await throwIfFailed(response);
  return response.json() as Promise<HerdrBridgeState>;
}

export async function runHerdrActionRequest(
  selector: string,
  action: HerdrAction,
  options: {
    workspaceId?: string;
    tabId?: string;
  } = {},
): Promise<HerdrBridgeState> {
  const response = await fetch(new URL("./api/herdr", window.location.href), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: selector,
      action,
      workspace_id: options.workspaceId,
      tab_id: options.tabId,
    }),
  });
  await throwIfFailed(response);
  return response.json() as Promise<HerdrBridgeState>;
}

export async function runHerdrSocketApiRequest(
  selector: string,
  method: string,
  params: JsonRecord = {},
  options: { id?: string } = {},
): Promise<HerdrSocketEnvelope> {
  const response = await fetch(new URL("./api/herdr/socket", window.location.href), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: selector,
      method,
      params,
      id: options.id,
    }),
  });
  await throwIfFailed(response);
  return response.json() as Promise<HerdrSocketEnvelope>;
}

async function throwIfFailed(response: Response) {
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
}
