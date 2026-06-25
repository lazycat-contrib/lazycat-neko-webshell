import type { WebshellNotification } from "../notifications-api";
import { escapeAttr, escapeHtml } from "../utils";
import {
  formatNotificationTime,
  notificationActionLabel,
  notificationDisplayBody,
  notificationDisplayTitle,
  type Translate,
} from "./presenter";

export function renderNotificationItemView(
  notification: WebshellNotification,
  tr: Translate,
  locale: string,
): string {
  const title = notificationDisplayTitle(notification, tr);
  const body = notificationDisplayBody(notification, tr);
  const time = notification.createdAtMs > 0
    ? formatNotificationTime(notification.createdAtMs, locale)
    : "";
  const actions = notification.state === "actioned"
    ? ""
    : notification.actions.map((action) => `
      <button class="command-button ${action.style === "primary" ? "primary" : action.style === "danger" ? "danger" : ""}" type="button" data-notification-id="${escapeAttr(notification.id)}" data-notification-action="${escapeAttr(action.id)}">
        ${escapeHtml(notificationActionLabel(notification, action, tr))}
      </button>
    `).join("");
  const link = notification.url
    ? `<a class="notification-link" href="${escapeAttr(notification.url)}" target="_blank" rel="noreferrer" data-notification-id="${escapeAttr(notification.id)}" data-notification-link>
        <i data-lucide="external-link"></i>
        <span>${escapeHtml(tr("action.openNotificationLink"))}</span>
      </a>`
    : "";
  return `
    <article class="notification-item" data-state="${escapeAttr(notification.state)}" data-severity="${escapeAttr(notification.severity)}" role="listitem">
      <div class="notification-item-head">
        <strong>${escapeHtml(title)}</strong>
        ${time ? `<time>${escapeHtml(time)}</time>` : ""}
      </div>
      ${body ? `<p>${escapeHtml(body)}</p>` : ""}
      ${link}
      <div class="notification-actions">
        ${actions}
        <button class="command-button" type="button" data-notification-id="${escapeAttr(notification.id)}" data-notification-command="read" ${notification.state !== "unread" ? "hidden" : ""}>
          ${escapeHtml(tr("action.markNotificationRead"))}
        </button>
        <button class="command-button" type="button" data-notification-id="${escapeAttr(notification.id)}" data-notification-command="dismiss">
          ${escapeHtml(tr("action.dismissNotification"))}
        </button>
      </div>
    </article>
  `;
}
