import {
  dismissNotification,
  fetchNotifications,
  markNotificationRead,
  runNotificationAction,
  type WebshellNotification,
} from "../notifications-api";

export type NotificationControllerOptions = {
  render: (notifications: WebshellNotification[]) => void;
  renderModal: (notification: WebshellNotification) => void;
  closeModal: () => void;
  activeModalId: () => string;
  refreshPomodoro: () => Promise<void>;
  onToast: (notification: WebshellNotification) => void;
  onPomodoroNotification: () => void;
  onLoadError: (error: unknown) => void;
  onActionError: (error: unknown) => void;
};

export type RefreshNotificationsOptions = {
  showToast?: boolean;
};

export function createNotificationController(options: NotificationControllerOptions) {
  let notifications: WebshellNotification[] = [];
  let loading = false;
  const seenIds = new Set<string>();

  function renderCurrent() {
    options.render(notifications);
  }

  async function refresh(refreshOptions: RefreshNotificationsOptions = {}) {
    if (loading) return;
    loading = true;
    try {
      const next = await fetchNotifications();
      notifications = next;
      renderCurrent();
      if (refreshOptions.showToast) {
        showNewToasts(next);
      } else {
        for (const notification of next) {
          seenIds.add(notification.id);
        }
      }
    } catch (error) {
      options.onLoadError(error);
    } finally {
      loading = false;
    }
  }

  async function runCommand(command: string, id: string) {
    if (!id) return;
    try {
      if (command === "read") {
        await markNotificationRead(id);
        closeModalIfActive(id);
      } else if (command === "dismiss") {
        await dismissNotification(id);
        closeModalIfActive(id);
      }
      await refreshAfterMutation();
    } catch (error) {
      options.onActionError(error);
    }
  }

  async function runAction(id: string, actionId: string) {
    if (!id || !actionId) return;
    try {
      await runNotificationAction(id, actionId);
      closeModalIfActive(id);
      await refreshAfterMutation();
    } catch (error) {
      options.onActionError(error);
    }
  }

  async function markRead(id: string) {
    if (!id) return;
    await markNotificationRead(id);
    await refresh({ showToast: false });
  }

  function showNewToasts(next: WebshellNotification[]) {
    for (const notification of next) {
      if (seenIds.has(notification.id)) continue;
      seenIds.add(notification.id);
      if (notification.state !== "unread" || notification.presentationHint === "center") continue;
      if (notification.presentationHint === "modal") {
        options.renderModal(notification);
      } else {
        options.onToast(notification);
      }
      if (notification.sourceKind === "pomodoro") {
        options.onPomodoroNotification();
      }
    }
  }

  async function refreshAfterMutation() {
    await Promise.all([
      refresh({ showToast: false }),
      options.refreshPomodoro(),
    ]);
  }

  function closeModalIfActive(id: string) {
    if (options.activeModalId() === id) {
      options.closeModal();
    }
  }

  return {
    renderCurrent,
    refresh,
    runCommand,
    runAction,
    markRead,
  };
}
