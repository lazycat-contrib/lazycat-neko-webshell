import { escapeAttr, escapeHtml } from "../utils";

export type TerminalControlOverlayState = {
  enabled: boolean;
  mode: "controller" | "observer" | "unknown";
  label: string;
  detail: string;
  pendingAction?: "take-control" | "release-control";
  takeControlTitle: string;
  releaseControlTitle: string;
};

export function renderTerminalControlOverlayView(state: TerminalControlOverlayState): string {
  if (!state.enabled || state.mode === "unknown") return "";
  const modeClass = state.mode === "controller" ? "is-controller" : "is-observer";
  const title = state.detail ? `${state.label} - ${state.detail}` : state.label;
  const pending = state.pendingAction;
  const action = state.mode === "observer"
    ? `<button type="button" class="terminal-control-action icon-button" data-terminal-control-action="take-control" title="${escapeAttr(state.takeControlTitle)}" aria-label="${escapeAttr(state.takeControlTitle)}" ${pending ? "disabled aria-busy=\"true\"" : ""}>
        <i data-lucide="${pending === "take-control" ? "loader-circle" : "mouse-pointer-click"}"></i>
      </button>`
    : `<button type="button" class="terminal-control-action icon-button" data-terminal-control-action="release-control" title="${escapeAttr(state.releaseControlTitle)}" aria-label="${escapeAttr(state.releaseControlTitle)}" ${pending ? "disabled aria-busy=\"true\"" : ""}>
        <i data-lucide="${pending === "release-control" ? "loader-circle" : "unlock"}"></i>
      </button>`;
  return `
    <div class="terminal-control-pill ${modeClass}" title="${escapeAttr(title)}" aria-label="${escapeAttr(title)}">
      <span class="terminal-control-dot" aria-hidden="true"></span>
      <span class="terminal-control-text">
        <strong>${escapeHtml(state.label)}</strong>
      </span>
      ${action}
    </div>
  `;
}
