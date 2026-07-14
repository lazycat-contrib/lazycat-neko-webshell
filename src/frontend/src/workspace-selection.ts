import type { Instance } from "./gen/lazycat/webshell/v1/capability_pb";
export { isRemoteClientSelector } from "./remote-client-terminal.ts";

const LAST_SELECTOR_STORAGE_KEY = "lazycat-neko-webshell.lastSelector";
const LAST_TAB_STORAGE_PREFIX = "lazycat-neko-webshell.lastTab";

export function normalizeSelector(value: unknown): string {
  return String(value ?? "").trim();
}

export function instanceSelector(instance: Instance | undefined): string {
  const explicit = normalizeSelector(instance?.selector);
  if (explicit) return explicit;
  const name = normalizeSelector(instance?.name);
  const ownerDeployId = normalizeSelector(instance?.ownerDeployId);
  return name && ownerDeployId ? `${name}@${ownerDeployId}` : "";
}

export function isRunningInstance(instance: Instance | undefined): boolean {
  return Boolean(
    instance
      && normalizeSelector(instance.status) === "running"
      && instanceSelector(instance),
  );
}

export function updateWorkspaceLocation(
  selector: string,
  options: {
    activeTabId?: string;
    replace?: boolean;
    tabId?: string;
  } = {},
) {
  const normalized = normalizeSelector(selector);
  if (!normalized) return;
  const url = new URL(window.location.href);
  url.searchParams.set("name", normalized);
  const tabId = normalizeSelector(options.tabId ?? options.activeTabId ?? "");
  if (tabId) {
    url.searchParams.set("tab", tabId);
  } else {
    url.searchParams.delete("tab");
  }
  const state = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
  const nextState: Record<string, unknown> = { ...state, name: normalized };
  if (tabId) {
    nextState.tab = tabId;
  } else {
    delete nextState.tab;
  }
  if (options.replace === false) {
    window.history.pushState(nextState, "", url);
    return;
  }
  window.history.replaceState(nextState, "", url);
}

export function requestedTabIdFromLocation(): string {
  return normalizeSelector(new URLSearchParams(window.location.search).get("tab") ?? "");
}

export function lastTabStorageKey(selector: string): string {
  return `${LAST_TAB_STORAGE_PREFIX}.${selector}`;
}

export function readRememberedTabId(selector: string): string {
  try {
    return normalizeSelector(window.localStorage.getItem(lastTabStorageKey(selector)) ?? "");
  } catch {
    return "";
  }
}

export function readRememberedSelector(): string {
  try {
    return normalizeSelector(window.localStorage.getItem(LAST_SELECTOR_STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
}

export function rememberSelector(selector: string) {
  const normalized = normalizeSelector(selector);
  if (!normalized) return;
  try {
    window.localStorage.setItem(LAST_SELECTOR_STORAGE_KEY, normalized);
  } catch {
    // localStorage is best-effort; URL and server workspace state remain authoritative.
  }
}
