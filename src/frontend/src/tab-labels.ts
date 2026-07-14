import type { MessageKey } from "./i18n";
import type { SessionBackendId, TerminalPane, TerminalTab, Tone } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function tabDisplayName(
  tab: TerminalTab,
  tabs: TerminalTab[],
  tr: Translate,
  herdrLabelForTab: (tab: TerminalTab) => string,
): string {
  return (isHerdrTab(tab) ? herdrLabelForTab(tab) : "")
    || tab.customTitle?.trim()
    || herdrLabelForTab(tab)
    || defaultTabDisplayName(tab, tabs, tr);
}

export function tabHasTextTitle(tab: TerminalTab, displayName: string): boolean {
  return Boolean(tab.customTitle?.trim()) || !/^\d+$/.test(displayName.trim());
}

export function tabPinnedGlyph(tab: TerminalTab, displayName: string): string {
  const source = displayName.trim() || tab.label.trim() || "T";
  const match = Array.from(source).find((char) => /[\p{Letter}\p{Number}]/u.test(char));
  return (match || source[0] || "T").toLocaleUpperCase();
}

export function sortedPinnedTabs(tabs: TerminalTab[]): TerminalTab[] {
  return tabs
    .filter((tab) => tab.pinned)
    .map((tab, index) => ({ tab, index }))
    .sort((left, right) => {
      const leftOrder = left.tab.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.tab.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map((entry) => entry.tab);
}

export function isHerdrTab(tab: TerminalTab): boolean {
  return tab.panes.some((pane) => pane.sessionBackend === "herdr");
}

export function tabTone(tab: TerminalTab, activePane: TerminalPane | undefined): Tone {
  if (tab.panes.some((pane) => pane.tone === "error")) return "error";
  return activePane?.tone ?? "neutral";
}

export function tabCurrentTitle(tab: TerminalTab, activePane: TerminalPane | undefined): string {
  return activePane?.title || tab.label;
}

export function remoteTabTitle(
  tab: Pick<TerminalTab, "customTitle" | "label">,
  activePane: Pick<TerminalPane, "programKind" | "title"> | undefined,
  deviceName: string,
): string {
  const device = deviceName.trim() || tab.label.trim();
  const detail = activePane?.programKind === "herdr"
    ? "Herdr"
    : activePane?.title.trim() || tab.customTitle?.trim() || "WebShell";
  return detail && detail !== device ? `${device} — ${detail}` : device;
}

export function defaultTabDisplayName(tab: TerminalTab, tabs: TerminalTab[], tr: Translate): string {
  if (tab.panes.some((pane) => pane.sessionBackend === "webshell")) {
    return tr("tab.terminalSession", { index: tabBackendOrdinal(tab, tabs, "webshell") });
  }
  if (tab.panes.some((pane) => pane.sessionBackend === "ssh")) {
    return `SSH ${tabBackendOrdinal(tab, tabs, "ssh")}`;
  }
  if (tab.panes.some((pane) => pane.sessionBackend === "zellij")) {
    return tr("tab.zellijSession", { index: tabBackendOrdinal(tab, tabs, "zellij") });
  }
  return String(tabs.findIndex((item) => item.id === tab.id) + 1);
}

function tabBackendOrdinal(tab: TerminalTab, tabs: TerminalTab[], backend: SessionBackendId): number {
  const index = tabs
    .filter((item) => item.panes.some((pane) => pane.sessionBackend === backend))
    .findIndex((item) => item.id === tab.id);
  return index >= 0 ? index + 1 : tabs.findIndex((item) => item.id === tab.id) + 1;
}
