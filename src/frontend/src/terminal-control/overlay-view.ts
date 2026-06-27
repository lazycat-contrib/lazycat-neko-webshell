import { escapeAttr, escapeHtml } from "../utils";

export type TerminalControlOverlayState = {
  enabled: boolean;
  mode: "controller" | "observer" | "unknown";
  label: string;
  detail: string;
  takeControlTitle: string;
};

export function renderTerminalControlOverlayView(state: TerminalControlOverlayState): string {
  if (!state.enabled || state.mode === "unknown") return "";
  const modeClass = state.mode === "controller" ? "is-controller" : "is-observer";
  const action = state.mode === "observer"
    ? `<button type="button" class="terminal-control-takeover icon-button" data-terminal-control-action="take-control" title="${escapeAttr(state.takeControlTitle)}" aria-label="${escapeAttr(state.takeControlTitle)}">
        <i data-lucide="mouse-pointer-click"></i>
      </button>`
    : "";
  return `
    <div class="terminal-control-pill ${modeClass}">
      <span class="terminal-control-dot" aria-hidden="true"></span>
      <span class="terminal-control-text">
        <strong>${escapeHtml(state.label)}</strong>
        <small>${escapeHtml(state.detail)}</small>
      </span>
      ${action}
    </div>
  `;
}
