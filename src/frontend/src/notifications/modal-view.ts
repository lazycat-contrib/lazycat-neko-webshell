import type { WebshellNotification } from "../notifications-api";
import { escapeAttr, escapeHtml } from "../utils";
import {
  notificationActionLabel,
  notificationDisplayBody,
  notificationDisplayTitle,
  type Translate,
} from "./presenter";

export function renderNotificationModalView(notification: WebshellNotification, tr: Translate): string {
  return `
    <article class="notification-modal-card" data-severity="${escapeAttr(notification.severity)}">
      <div class="notification-modal-head">
        <div>
          <strong>${escapeHtml(notificationDisplayTitle(notification, tr))}</strong>
          <p>${escapeHtml(notificationDisplayBody(notification, tr))}</p>
        </div>
        <button class="icon-button" type="button" data-notification-id="${escapeAttr(notification.id)}" data-notification-command="read" aria-label="${escapeAttr(tr("action.close"))}" title="${escapeAttr(tr("action.close"))}">
          <i data-lucide="x"></i>
        </button>
      </div>
      <div class="notification-actions">
        ${notification.actions.map((action) => `
          <button class="command-button ${action.style === "primary" ? "primary" : action.style === "danger" ? "danger" : ""}" type="button" data-notification-id="${escapeAttr(notification.id)}" data-notification-action="${escapeAttr(action.id)}">
            ${escapeHtml(notificationActionLabel(notification, action, tr))}
          </button>
        `).join("")}
        <button class="command-button" type="button" data-notification-id="${escapeAttr(notification.id)}" data-notification-command="dismiss">
          ${escapeHtml(tr("action.dismissNotification"))}
        </button>
      </div>
    </article>
  `;
}
