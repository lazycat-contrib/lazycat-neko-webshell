export type PomodoroStatus = "idle" | "running" | "completed";

export type PomodoroState = {
  status: PomodoroStatus;
  durationMinutes: number;
  totalRounds: number;
  currentRound: number;
  startedAtMs: number;
  deadlineMs: number;
  completedAtMs?: number;
  notificationId?: string;
};

export const POMODORO_DEFAULT_MINUTES = 25;
export const POMODORO_DEFAULT_ROUNDS = 4;
export const POMODORO_MIN_MINUTES = 1;
export const POMODORO_MAX_MINUTES = 180;
export const POMODORO_MIN_ROUNDS = 1;
export const POMODORO_MAX_ROUNDS = 8;

export function idlePomodoroState(): PomodoroState {
  return {
    status: "idle",
    durationMinutes: POMODORO_DEFAULT_MINUTES,
    totalRounds: POMODORO_DEFAULT_ROUNDS,
    currentRound: 0,
    startedAtMs: 0,
    deadlineMs: 0,
  };
}

export function normalizePomodoroMinutes(value: unknown, fallback = POMODORO_DEFAULT_MINUTES): number {
  const number = Number(value);
  const minutes = Number.isFinite(number) ? Math.round(number) : fallback;
  return Math.min(POMODORO_MAX_MINUTES, Math.max(POMODORO_MIN_MINUTES, minutes));
}

export function normalizePomodoroRounds(value: unknown, fallback = POMODORO_DEFAULT_ROUNDS): number {
  const number = Number(value);
  const rounds = Number.isFinite(number) ? Math.round(number) : fallback;
  return Math.min(POMODORO_MAX_ROUNDS, Math.max(POMODORO_MIN_ROUNDS, rounds));
}

export function remainingPomodoroMs(state: PomodoroState, now = Date.now()): number {
  if (state.status !== "running") return 0;
  return Math.max(0, state.deadlineMs - now);
}

export function formatPomodoroRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export async function fetchPomodoroState(): Promise<PomodoroState> {
  const response = await fetch(new URL("./api/tasks/pomodoro", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  return parsePomodoroResponse(response, "failed to load Pomodoro state");
}

export async function startPomodoroTask(minutes: number, rounds: number, currentRound = 1): Promise<PomodoroState> {
  const response = await fetch(new URL("./api/tasks/pomodoro/start", window.location.href), {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      minutes: normalizePomodoroMinutes(minutes),
      rounds: normalizePomodoroRounds(rounds),
      currentRound: normalizePomodoroCurrentRound(currentRound, rounds),
    }),
  });
  return parsePomodoroResponse(response, "failed to start Pomodoro");
}

export function nextPomodoroRound(state: PomodoroState): number {
  if (state.currentRound > 0 && state.currentRound < state.totalRounds) {
    return state.currentRound + 1;
  }
  return 1;
}

export async function stopPomodoroTask(): Promise<PomodoroState> {
  const response = await fetch(new URL("./api/tasks/pomodoro/stop", window.location.href), {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
  });
  return parsePomodoroResponse(response, "failed to stop Pomodoro");
}

export async function dismissPomodoroTask(): Promise<PomodoroState> {
  const response = await fetch(new URL("./api/tasks/pomodoro/dismiss", window.location.href), {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
  });
  return parsePomodoroResponse(response, "failed to dismiss Pomodoro");
}

async function parsePomodoroResponse(response: Response, fallback: string): Promise<PomodoroState> {
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || fallback);
  }
  return normalizePomodoroState(await response.json());
}

function normalizePomodoroState(value: unknown): PomodoroState {
  if (!value || typeof value !== "object") return idlePomodoroState();
  const record = value as Record<string, unknown>;
  const status = record.status === "running" || record.status === "completed" ? record.status : "idle";
  const durationMinutes = normalizePomodoroMinutes(record.durationMinutes);
  const totalRounds = normalizePomodoroRounds(record.totalRounds);
  if (status === "idle") {
    return {
      ...idlePomodoroState(),
      durationMinutes,
      totalRounds,
    };
  }
  return {
    status,
    durationMinutes,
    totalRounds,
    currentRound: Math.min(totalRounds, Math.max(1, Math.round(Number(record.currentRound) || 1))),
    startedAtMs: finiteTimestamp(record.startedAtMs),
    deadlineMs: finiteTimestamp(record.deadlineMs),
    completedAtMs: optionalTimestamp(record.completedAtMs),
    notificationId: typeof record.notificationId === "string" && record.notificationId.trim()
      ? record.notificationId.trim()
      : undefined,
  };
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function optionalTimestamp(value: unknown): number | undefined {
  const timestamp = finiteTimestamp(value);
  return timestamp > 0 ? timestamp : undefined;
}

function normalizePomodoroCurrentRound(value: unknown, rounds: unknown): number {
  const totalRounds = normalizePomodoroRounds(rounds);
  const number = Number(value);
  const round = Number.isFinite(number) ? Math.round(number) : 1;
  return Math.min(totalRounds, Math.max(1, round));
}
