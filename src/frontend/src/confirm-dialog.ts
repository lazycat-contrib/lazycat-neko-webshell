import { escapeAttr, escapeHtml } from "./utils";

type ConfirmDialogElements = {
  notificationModal: HTMLElement;
  notificationModalBody: HTMLElement;
};

export type ConfirmDialogRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
};

export function createConfirmDialog(options: {
  elements: ConfirmDialogElements;
  prepareOverlay: () => void;
  updateIcons: () => void;
  closeNotificationModal: () => void;
}) {
  let active: {
    resolve: (confirmed: boolean) => void;
    restoreFocus: Element | null;
  } | undefined;

  const { elements } = options;

  elements.notificationModal.addEventListener("click", (event) => {
    if (!active) return;
    if (event.target !== elements.notificationModal) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    settle(false);
  });

  elements.notificationModalBody.addEventListener("click", (event) => {
    if (!active) return;
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest<HTMLButtonElement>("[data-confirm-action]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    settle(button.dataset.confirmAction === "confirm");
  });

  document.addEventListener("keydown", (event) => {
    if (!active || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    settle(false);
  }, true);

  function confirm(request: ConfirmDialogRequest): Promise<boolean> {
    if (active) {
      settle(false);
    }
    const restoreFocus = document.activeElement;
    options.closeNotificationModal();
    options.prepareOverlay();
    elements.notificationModalBody.innerHTML = renderConfirmDialog(request);
    elements.notificationModal.hidden = false;
    options.updateIcons();
    return new Promise((resolve) => {
      active = { resolve, restoreFocus };
      focusInitialButton();
    });
  }

  function settle(confirmed: boolean) {
    if (!active) return;
    const current = active;
    active = undefined;
    elements.notificationModal.hidden = true;
    elements.notificationModalBody.replaceChildren();
    current.resolve(confirmed);
    if (current.restoreFocus instanceof HTMLElement) {
      current.restoreFocus.focus({ preventScroll: true });
    }
  }

  function focusInitialButton() {
    window.requestAnimationFrame(() => {
      elements.notificationModalBody
        .querySelector<HTMLButtonElement>("[data-confirm-action='cancel']")
        ?.focus({ preventScroll: true });
    });
  }

  function isOpen(): boolean {
    return Boolean(active);
  }

  function cancel() {
    settle(false);
  }

  return {
    confirm,
    isOpen,
    cancel,
  };
}

function renderConfirmDialog(request: ConfirmDialogRequest): string {
  const severity = request.danger ? "error" : "warning";
  const confirmClass = request.danger ? "command-button primary danger" : "command-button primary";
  return `
    <article class="notification-modal-card" data-severity="${escapeAttr(severity)}">
      <div class="notification-modal-head">
        <div>
          <strong>${escapeHtml(request.title)}</strong>
          <p>${escapeHtml(request.message)}</p>
        </div>
        <button class="icon-button" type="button" data-confirm-action="cancel" aria-label="${escapeAttr(request.cancelLabel)}" title="${escapeAttr(request.cancelLabel)}">
          <i data-lucide="x"></i>
        </button>
      </div>
      <div class="notification-actions">
        <button class="command-button" type="button" data-confirm-action="cancel">
          ${escapeHtml(request.cancelLabel)}
        </button>
        <button class="${escapeAttr(confirmClass)}" type="button" data-confirm-action="confirm">
          ${escapeHtml(request.confirmLabel)}
        </button>
      </div>
    </article>
  `;
}
