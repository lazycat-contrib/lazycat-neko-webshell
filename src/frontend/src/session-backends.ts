import type { MessageKey } from "./i18n";
import type { SessionBackendId, SessionBackendsState, SessionBackendInfo } from "./types";
import { escapeAttr, escapeHtml } from "./utils";

export type SessionMode = SessionBackendId;

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

const WEB_SHELL_BACKEND: SessionBackendInfo = {
  id: "webshell",
  label: "WebShell native",
  available: true,
};

export function selectableSessionBackends(state: SessionBackendsState | undefined): SessionBackendInfo[] {
  const backends = state?.backends ?? [WEB_SHELL_BACKEND];
  return backends.filter((backend) => backend.available || backend.id === "webshell");
}

export function normalizeSessionMode(value: unknown): SessionMode {
  return value === "herdr" || value === "zellij" || value === "ssh" ? value : "webshell";
}

export function sessionBackendInstalled(
  state: SessionBackendsState | undefined,
  mode: SessionMode,
): boolean {
  return selectableSessionBackends(state).some((backend) => backend.id === mode);
}

export function sessionBackendIsSelectable(
  state: SessionBackendsState | undefined,
  mode: SessionMode,
): boolean {
  if (!state && mode === "webshell") return true;
  return selectableSessionBackends(state).some((backend) => backend.id === mode);
}

export function sessionBackendLabel(id: SessionBackendId, fallback: string, tr: Translate): string {
  if (id === "webshell") return tr("backend.webshell");
  if (id === "herdr") return tr("backend.herdr");
  if (id === "zellij") return tr("backend.zellij");
  return fallback;
}

export function sessionBackendSupportsTerminalTransfer(backend: SessionBackendInfo | undefined): boolean {
  return Boolean(backend?.supportsTerminalTransfer ?? backend?.supports_terminal_transfer);
}

export function renderSessionBackendSelectOptions(
  backends: SessionBackendInfo[],
  tr: Translate,
): string {
  return backends
    .map((backend) => `<option value="${escapeAttr(backend.id)}">${escapeHtml(sessionBackendLabel(backend.id, backend.label, tr))}</option>`)
    .join("");
}
