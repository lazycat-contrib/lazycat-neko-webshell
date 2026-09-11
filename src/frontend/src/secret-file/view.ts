import type { MessageKey } from "../i18n";
import { secretFileShortcutLabel, type SecretFileShortcut } from "./state.ts";
import "./styles.css";

export type SecretTranslate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function secretElement<K extends keyof HTMLElementTagNameMap>(tag: K, value = "", className = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = value;
  element.className = className;
  return element;
}

export function createSecretFileView(tr: SecretTranslate, close: (instant?: boolean) => void, shortcutChanged: (value: SecretFileShortcut) => void) {
  const dialog = secretElement("dialog", "", "secret-file-dialog");
  dialog.setAttribute("aria-labelledby", "secret-file-title");
  const header = secretElement("div", "", "secret-file-head");
  const title = secretElement("h2", tr("secret.title"));
  title.id = "secret-file-title";
  const closeButton = secretElement("button", "×", "icon-button secret-file-close");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", tr("secret.close"));
  closeButton.onclick = () => close();
  header.append(title, closeButton);
  const target = secretElement("p", "", "secret-file-target");
  const content = secretElement("div", "", "secret-file-content");
  const status = secretElement("p", "", "secret-file-status");
  status.setAttribute("role", "status");
  const settings = secretElement("details", "", "secret-file-shortcut");
  const summary = secretElement("summary", tr("secret.shortcut"));
  const select = secretElement("select");
  select.setAttribute("aria-label", tr("secret.shortcut"));
  const apple = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  for (const value of ["alt-v", "alt-k", "disabled"] as const) {
    const option = secretElement("option", value === "disabled" ? tr("secret.disabled") : secretFileShortcutLabel(value, apple));
    option.value = value;
    select.append(option);
  }
  select.onchange = () => shortcutChanged(select.value as SecretFileShortcut);
  settings.append(summary, select);
  dialog.append(header, target, status, content, settings);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(true); });
  // Prevent app-wide terminal and Escape handlers from acting behind this modal.
  dialog.addEventListener("keydown", event => event.stopPropagation());
  dialog.addEventListener("paste", event => event.stopPropagation());
  document.body.append(dialog);
  function button(key: MessageKey, handler: () => void, primary = false) {
    const button = secretElement("button", tr(key), `command-button${primary ? " primary" : ""}`);
    button.type = "button";
    button.onclick = handler;
    return button;
  }
  function syncViewport() {
    const viewport = window.visualViewport;
    if (!viewport || !dialog.open) return;
    dialog.style.setProperty("--secret-viewport-height", `${Math.max(120, viewport.height - 16)}px`);
    dialog.style.setProperty("--secret-viewport-bottom", `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`);
  }
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  function destroy() {
    window.visualViewport?.removeEventListener("resize", syncViewport);
    window.visualViewport?.removeEventListener("scroll", syncViewport);
    dialog.remove();
  }
  return { dialog, content, target, status, select, closeButton, button, tr, apple, syncViewport, destroy };
}
