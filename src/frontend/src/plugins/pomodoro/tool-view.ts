import type { MessageKey } from "../../i18n";
import type { PomodoroState } from "../../pomodoro";
import { escapeAttr, escapeHtml } from "../../utils";

export type PomodoroToolTranslate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type PomodoroToolViewState = {
  disabled: boolean;
  state: PomodoroState;
  draftMinutes: number;
  draftRounds: number;
  roundText: string;
  remainingText: string;
  endTimeText: string;
  tr: PomodoroToolTranslate;
};

export function renderPomodoroToolView(state: PomodoroToolViewState): string {
  const disabledAttr = state.disabled ? "disabled" : "";
  const mode = state.state.status;
  const title = mode === "running"
    ? state.tr("pomodoro.runningTitle")
    : mode === "completed"
      ? state.tr("pomodoro.completeTitle")
      : state.tr("pomodoro.title");
  const hint = mode === "running"
    ? state.tr("pomodoro.runningHint", { time: state.endTimeText })
    : mode === "completed"
      ? state.tr("pomodoro.completeHint")
      : state.tr("pomodoro.setupHint");
  const inputDisabled = state.disabled || mode !== "idle";
  const totalRounds = Math.max(1, mode === "idle" ? state.draftRounds : state.state.totalRounds);
  const currentRound = mode === "idle" ? 0 : Math.max(1, state.state.currentRound);
  const againLabel = mode === "completed" && currentRound < totalRounds
    ? state.tr("action.pomodoroNextRound")
    : state.tr("action.pomodoroAgain");
  const againIcon = mode === "completed" && currentRound < totalRounds ? "skip-forward" : "rotate-ccw";
  const actionButton = (
    action: string,
    label: string,
    icon: string,
    tone: "default" | "primary" | "danger",
    hidden: boolean,
  ) => `
    <button
      class="command-button icon-only-large pomodoro-action-button ${tone === "primary" ? "primary" : tone === "danger" ? "danger" : ""}"
      type="button"
      data-pomodoro-action="${escapeAttr(action)}"
      aria-label="${escapeAttr(label)}"
      title="${escapeAttr(label)}"
      ${disabledAttr}
      ${hidden ? "hidden" : ""}
    >
      <i data-lucide="${escapeAttr(icon)}" aria-hidden="true"></i>
      <span class="pomodoro-action-tip" aria-hidden="true">${escapeHtml(label)}</span>
    </button>
  `;
  const roundDots = Array.from({ length: totalRounds }, (_, index) => {
    const round = index + 1;
    const dotState = currentRound > round ? "done" : currentRound === round ? "active" : "pending";
    return `<span data-round="${dotState}"></span>`;
  }).join("");
  const presetButton = (minutes: number, labelKey: MessageKey) => {
    const active = mode === "idle" && state.draftMinutes === minutes;
    return `
      <button type="button" data-pomodoro-preset="${minutes}" aria-pressed="${active}" ${inputDisabled ? "disabled" : ""}>
        ${escapeHtml(state.tr(labelKey))}
      </button>
    `;
  };
  return `
    <div class="plugin-tool pomodoro-tool" data-pomodoro-state="${escapeAttr(mode)}">
      <div class="plugin-tool-head pomodoro-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(state.tr("plugin.pomodoro.name"))}</div>
          <p class="settings-help">${escapeHtml(hint)}</p>
        </div>
        <span class="pomodoro-state-pill">${escapeHtml(title)}</span>
      </div>
      <div class="pomodoro-meter" aria-live="polite">
        <span>${escapeHtml(state.tr("pomodoro.remaining"))}</span>
        <strong>${escapeHtml(state.remainingText)}</strong>
      </div>
      <div class="pomodoro-rounds" aria-label="${escapeAttr(state.roundText)}">
        <div class="pomodoro-round-dots">${roundDots}</div>
        <span>${escapeHtml(state.roundText)}</span>
      </div>
      <div class="pomodoro-presets" aria-label="${escapeAttr(state.tr("pomodoro.presets"))}">
        ${presetButton(25, "pomodoro.preset25")}
        ${presetButton(15, "pomodoro.preset15")}
        ${presetButton(5, "pomodoro.preset5")}
      </div>
      <label class="pomodoro-field">
        <span>${escapeHtml(state.tr("pomodoro.customMinutes"))}</span>
        <input
          type="number"
          min="1"
          max="180"
          step="1"
          inputmode="numeric"
          autocomplete="off"
          data-pomodoro-minutes
          value="${escapeAttr(String(state.draftMinutes))}"
          ${inputDisabled ? "disabled" : ""}
        />
      </label>
      <label class="pomodoro-field">
        <span>${escapeHtml(state.tr("pomodoro.rounds"))}</span>
        <input
          type="number"
          min="1"
          max="8"
          step="1"
          inputmode="numeric"
          autocomplete="off"
          data-pomodoro-rounds
          value="${escapeAttr(String(state.draftRounds))}"
          ${inputDisabled ? "disabled" : ""}
        />
      </label>
      <div class="pomodoro-actions">
        ${actionButton("stop", state.tr("action.pomodoroStop"), "square", "danger", mode !== "running")}
        ${actionButton("dismiss", state.tr("action.pomodoroDismiss"), "check", "default", mode !== "completed")}
        ${actionButton("again", againLabel, againIcon, "primary", mode !== "completed")}
        ${actionButton("start", state.tr("action.pomodoroStart"), "play", "primary", mode !== "idle")}
      </div>
    </div>
  `;
}
