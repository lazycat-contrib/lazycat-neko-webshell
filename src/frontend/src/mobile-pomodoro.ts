export type MobilePomodoroStatus = "idle" | "running" | "completed";

export type MobilePomodoroState = {
  status: MobilePomodoroStatus;
  durationMinutes: number;
  startedAt: number;
  deadline: number;
  completedAt?: number;
};

export const MOBILE_POMODORO_DEFAULT_MINUTES = 25;
export const MOBILE_POMODORO_MIN_MINUTES = 1;
export const MOBILE_POMODORO_MAX_MINUTES = 180;

const MOBILE_POMODORO_STORAGE_KEY = "lazycat-neko-webshell:mobile-pomodoro";
const MINUTE_MS = 60_000;

export function idleMobilePomodoroState(): MobilePomodoroState {
  return {
    status: "idle",
    durationMinutes: MOBILE_POMODORO_DEFAULT_MINUTES,
    startedAt: 0,
    deadline: 0,
  };
}

export function normalizeMobilePomodoroMinutes(value: unknown, fallback = MOBILE_POMODORO_DEFAULT_MINUTES): number {
  const number = Number(value);
  const minutes = Number.isFinite(number) ? Math.round(number) : fallback;
  return Math.min(MOBILE_POMODORO_MAX_MINUTES, Math.max(MOBILE_POMODORO_MIN_MINUTES, minutes));
}

export function startMobilePomodoro(minutes: unknown, now = Date.now()): MobilePomodoroState {
  const durationMinutes = normalizeMobilePomodoroMinutes(minutes);
  return {
    status: "running",
    durationMinutes,
    startedAt: now,
    deadline: now + durationMinutes * MINUTE_MS,
  };
}

export function reconcileMobilePomodoroState(state: MobilePomodoroState, now = Date.now()): MobilePomodoroState {
  if (state.status !== "running" || state.deadline > now) return state;
  return {
    ...state,
    status: "completed",
    completedAt: state.completedAt ?? state.deadline,
  };
}

export function remainingMobilePomodoroMs(state: MobilePomodoroState, now = Date.now()): number {
  if (state.status !== "running") return 0;
  return Math.max(0, state.deadline - now);
}

export function formatMobilePomodoroRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function loadMobilePomodoroState(now = Date.now()): MobilePomodoroState {
  try {
    const raw = window.localStorage.getItem(MOBILE_POMODORO_STORAGE_KEY);
    if (!raw) return idleMobilePomodoroState();
    return reconcileMobilePomodoroState(normalizeStoredMobilePomodoroState(JSON.parse(raw)), now);
  } catch {
    return idleMobilePomodoroState();
  }
}

export function storeMobilePomodoroState(state: MobilePomodoroState): void {
  try {
    if (state.status === "idle") {
      window.localStorage.removeItem(MOBILE_POMODORO_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(MOBILE_POMODORO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Pomodoro is an ephemeral UI aid. Storage failure should not affect terminal use.
  }
}

function normalizeStoredMobilePomodoroState(value: unknown): MobilePomodoroState {
  if (!value || typeof value !== "object") return idleMobilePomodoroState();
  const record = value as Record<string, unknown>;
  const status = record.status === "running" || record.status === "completed" ? record.status : "idle";
  const durationMinutes = normalizeMobilePomodoroMinutes(record.durationMinutes);
  const startedAt = finiteTimestamp(record.startedAt);
  const deadline = finiteTimestamp(record.deadline);
  const completedAt = finiteTimestamp(record.completedAt);
  if (status === "idle" || deadline <= 0) return idleMobilePomodoroState();
  return {
    status,
    durationMinutes,
    startedAt,
    deadline,
    completedAt: completedAt > 0 ? completedAt : undefined,
  };
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
