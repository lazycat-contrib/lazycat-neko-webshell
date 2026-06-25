import type { MessageKey } from "../i18n";
import type { WebshellNotification } from "../notifications-api";
import type { Tone } from "../types";

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function notificationDisplayTitle(notification: WebshellNotification, tr: Translate): string {
  if (notification.sourceKind === "pomodoro") return tr("pomodoro.completeTitle");
  return notification.title || tr("section.notifications");
}

export function notificationDisplayBody(notification: WebshellNotification, tr: Translate): string {
  if (notification.sourceKind === "pomodoro") return tr("pomodoro.completeHint");
  return notification.body;
}

export function notificationActionLabel(
  notification: WebshellNotification,
  action: { id: string; label: string; payload?: unknown },
  tr: Translate,
): string {
  if (notification.sourceKind === "pomodoro") {
    if (action.id === "pomodoro.again") {
      return notificationPomodoroNextRound(action) > 1
        ? tr("action.pomodoroNextRound")
        : tr("action.pomodoroAgain");
    }
    if (action.id === "pomodoro.dismiss") return tr("action.pomodoroDismiss");
  }
  return action.label;
}

export function notificationTone(notification: WebshellNotification): Tone {
  if (notification.severity === "error") return "error";
  if (notification.severity === "success") return "ok";
  return "neutral";
}

export function formatNotificationTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === "auto" ? undefined : locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function notificationPomodoroNextRound(action: { payload?: unknown }): number {
  if (!action.payload || typeof action.payload !== "object") return 1;
  const value = (action.payload as Record<string, unknown>).nextRound;
  const round = Number(value);
  return Number.isFinite(round) && round > 0 ? Math.round(round) : 1;
}
