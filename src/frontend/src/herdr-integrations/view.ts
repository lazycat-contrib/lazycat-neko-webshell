import type { MessageKey } from "../i18n.ts";
import type { HerdrIntegrationsScreen } from "./controller.ts";
import { herdrIntegrationsTabTarget, restoreHerdrIntegrationsFocus } from "./view-focus.ts";
import { renderHerdrIntegrationsDialog } from "./view-render.ts";

import "./view.css";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function createHerdrIntegrationsView(options: {
  root?: HTMLElement;
  tr: Translate;
  prepare: () => void;
  updateIcons: () => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  let dialog: HTMLDialogElement | undefined;
  let returnFocus: HTMLElement | undefined;

  function present(screen: HerdrIntegrationsScreen) {
    if (!dialog) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      options.prepare();
      dialog = document.createElement("dialog");
      dialog.className = "herdr-console-dialog herdr-integrations-dialog";
      dialog.setAttribute("aria-labelledby", "herdr-integrations-title");
      dialog.addEventListener("click", handleClick);
      dialog.addEventListener("keydown", handleKeydown);
      dialog.addEventListener("cancel", handleCancel);
      (options.root ?? document.body).append(dialog);
    }
    dialog.innerHTML = renderHerdrIntegrationsDialog(screen, options.tr);
    if (!dialog.open) dialog.showModal();
    options.updateIcons();
    requestAnimationFrame(() => {
      dialog?.querySelector<HTMLElement>("[data-herdr-integrations-close]")?.focus({ preventScroll: true });
    });
  }

  function close(restoreFocus: boolean) {
    if (dialog?.open) dialog.close();
    dialog?.remove();
    dialog = undefined;
    if (restoreFocus) restoreHerdrIntegrationsFocus(returnFocus);
    returnFocus = undefined;
  }

  function handleClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (target === dialog || target?.closest("[data-herdr-integrations-close]")) {
      options.onClose();
      return;
    }
    if (target?.closest("[data-herdr-integrations-refresh]")) options.onRefresh();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      options.onClose();
      return;
    }
    if (event.key !== "Tab" || !dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]):not([hidden]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ));
    const target = herdrIntegrationsTabTarget(
      focusable,
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
      event.shiftKey,
    );
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  }

  function handleCancel(event: Event) {
    event.preventDefault();
    options.onClose();
  }

  return { present, close };
}
