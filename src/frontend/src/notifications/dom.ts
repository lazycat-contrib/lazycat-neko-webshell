import type { WebshellNotification } from "../notifications-api";
import { escapeHtml } from "../utils";
import { renderNotificationItemView } from "./item-view";
import { renderNotificationModalView } from "./modal-view";
import type { Translate } from "./presenter";

export type NotificationDomElements = {
  notificationsMenu: HTMLElement;
  notificationsButton: HTMLButtonElement;
  notificationsShell: HTMLElement;
  notificationCount: HTMLElement;
  notificationList: HTMLElement;
  notificationModal: HTMLElement;
  notificationModalBody: HTMLElement;
};

export type NotificationDomOptions = {
  elements: NotificationDomElements;
  prepareOverlay: () => void;
  updateIcons: () => void;
};

export function createNotificationDom(options: NotificationDomOptions) {
  let activeModalId = "";
  const elements = options.elements;

  function render(notifications: WebshellNotification[], tr: Translate, locale: string) {
    const hasNotifications = notifications.length > 0;
    const unreadCount = notifications.filter((notification) => notification.state === "unread").length;
    elements.notificationsShell.hidden = !hasNotifications;
    if (!hasNotifications) {
      closeMenu();
    }
    elements.notificationCount.hidden = unreadCount === 0;
    elements.notificationCount.textContent = unreadCount === 0 ? "" : unreadCount > 9 ? "9+" : String(unreadCount);
    elements.notificationsButton.classList.toggle("has-unread", unreadCount > 0);
    elements.notificationList.innerHTML = notifications.length
      ? notifications.map((notification) => renderNotificationItemView(notification, tr, locale)).join("")
      : `<p class="notification-empty">${escapeHtml(tr("status.noNotifications"))}</p>`;
    if (activeModalId) {
      const modalNotification = notifications.find((notification) => notification.id === activeModalId);
      if (modalNotification && modalNotification.state !== "dismissed") {
        renderModal(modalNotification, tr);
      } else {
        closeModal();
      }
    }
    options.updateIcons();
  }

  function renderModal(notification: WebshellNotification, tr: Translate) {
    options.prepareOverlay();
    activeModalId = notification.id;
    elements.notificationModalBody.innerHTML = renderNotificationModalView(notification, tr);
    elements.notificationModal.hidden = false;
    options.updateIcons();
  }

  function closeModal() {
    activeModalId = "";
    elements.notificationModal.hidden = true;
    elements.notificationModalBody.replaceChildren();
  }

  function closeMenu() {
    elements.notificationsMenu.hidden = true;
    elements.notificationsButton.setAttribute("aria-expanded", "false");
  }

  function activeNotificationModalId(): string {
    return activeModalId;
  }

  return {
    render,
    renderModal,
    closeModal,
    closeMenu,
    activeNotificationModalId,
  };
}
