import {
  formatPomodoroRemaining,
  remainingPomodoroMs,
  type PomodoroState,
} from "../../pomodoro";
import type { PomodoroToolTranslate, PomodoroToolViewState } from "./tool-view";

export type PomodoroToolPresenterInput = {
  disabled: boolean;
  state: PomodoroState;
  draftMinutes: number;
  draftRounds: number;
  tr: PomodoroToolTranslate;
  formatDeadline: (date: Date) => string;
};

export function pomodoroToolViewState(input: PomodoroToolPresenterInput): PomodoroToolViewState {
  const remainingText = input.state.status === "running"
    ? formatPomodoroRemaining(remainingPomodoroMs(input.state))
    : input.state.status === "completed"
      ? "00:00"
      : formatPomodoroRemaining(input.draftMinutes * 60_000);
  const endTimeText = input.state.deadlineMs > 0
    ? input.formatDeadline(new Date(input.state.deadlineMs))
    : "";
  const currentRound = input.state.status === "idle" ? 0 : input.state.currentRound;
  return {
    disabled: input.disabled,
    state: input.state,
    draftMinutes: input.draftMinutes,
    draftRounds: input.draftRounds,
    roundText: currentRound > 0
      ? input.tr("pomodoro.roundProgress", { current: currentRound, total: input.state.totalRounds })
      : input.tr("pomodoro.roundSetup", { total: input.draftRounds }),
    remainingText,
    endTimeText,
    tr: input.tr,
  };
}
