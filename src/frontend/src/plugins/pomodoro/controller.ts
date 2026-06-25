import {
  dismissPomodoroTask,
  fetchPomodoroState,
  idlePomodoroState,
  nextPomodoroRound,
  normalizePomodoroMinutes,
  normalizePomodoroRounds,
  POMODORO_DEFAULT_MINUTES,
  POMODORO_DEFAULT_ROUNDS,
  startPomodoroTask,
  stopPomodoroTask,
  type PomodoroState,
} from "../../pomodoro";

export type PomodoroControllerOptions = {
  isEnabled: () => boolean;
  refreshNotifications: () => Promise<void>;
  dismissNotification: (id: string) => Promise<void>;
  onRender: () => void;
  onComplete: () => void;
  onActionError: (error: unknown) => void;
  onRefreshError: (error: unknown) => void;
};

export function createPomodoroController(options: PomodoroControllerOptions) {
  let state = idlePomodoroState();
  let draftMinutes = state.durationMinutes || POMODORO_DEFAULT_MINUTES;
  let draftRounds = state.totalRounds || POMODORO_DEFAULT_ROUNDS;
  let loading = false;

  function viewState() {
    return {
      state,
      draftMinutes,
      draftRounds,
    };
  }

  function isRunning(): boolean {
    return state.status === "running";
  }

  function setDraftMinutes(value: unknown) {
    draftMinutes = normalizePomodoroMinutes(value, draftMinutes);
  }

  function setDraftRounds(value: unknown) {
    draftRounds = normalizePomodoroRounds(value, draftRounds);
  }

  async function refresh(render = true) {
    if (loading) return;
    loading = true;
    try {
      setState(await fetchPomodoroState(), { render });
    } catch (error) {
      options.onRefreshError(error);
    } finally {
      loading = false;
    }
  }

  async function runAction(action: string) {
    if (!options.isEnabled()) return;
    try {
      if (action === "start") {
        setState(await startPomodoroTask(draftMinutes, draftRounds));
      } else if (action === "stop") {
        setState(await stopPomodoroTask());
      } else if (action === "dismiss") {
        setState(await dismissPomodoroTask());
        await options.refreshNotifications();
      } else if (action === "again") {
        const minutes = state.durationMinutes || draftMinutes || POMODORO_DEFAULT_MINUTES;
        const rounds = state.totalRounds || draftRounds || POMODORO_DEFAULT_ROUNDS;
        const previousNotificationId = state.notificationId;
        setState(await startPomodoroTask(minutes, rounds, nextPomodoroRound(state)));
        if (previousNotificationId) {
          await options.dismissNotification(previousNotificationId);
        }
        await options.refreshNotifications();
      }
    } catch (error) {
      options.onActionError(error);
    }
  }

  function setState(next: PomodoroState, optionsOverride: { render?: boolean } = {}) {
    const previousStatus = state.status;
    state = next;
    draftMinutes = normalizePomodoroMinutes(state.durationMinutes || draftMinutes);
    draftRounds = normalizePomodoroRounds(state.totalRounds || draftRounds);
    if (previousStatus === "running" && state.status === "completed") {
      options.onComplete();
    }
    if (optionsOverride.render !== false) {
      options.onRender();
    }
  }

  return {
    viewState,
    isRunning,
    setDraftMinutes,
    setDraftRounds,
    refresh,
    runAction,
  };
}
