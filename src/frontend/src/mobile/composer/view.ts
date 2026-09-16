import type { MessageKey } from "../../i18n.ts";
import "./styles.css";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type Handlers = {
  close: () => void;
  discard: () => void;
  submit: (enter: boolean) => void;
  input: () => void;
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

export function createMobileComposerView(tr: Translate, handlers: Handlers) {
  const dialog = element("dialog", "", "mobile-composer");
  dialog.setAttribute("aria-labelledby", "mobile-composer-title");
  dialog.setAttribute("aria-describedby", "mobile-composer-hint mobile-composer-status");

  const header = element("header", "", "mobile-composer-head");
  const heading = element("div", "", "mobile-composer-heading");
  const title = element("h2", tr("mobileComposer.title"));
  title.id = "mobile-composer-title";
  const target = element("p", "", "mobile-composer-target");
  heading.append(title, target);

  const close = element("button", "×", "icon-button mobile-composer-close");
  close.type = "button";
  close.setAttribute("aria-label", tr("mobileComposer.close"));
  close.addEventListener("click", handlers.close);
  header.append(heading, close);

  const label = element("label", tr("mobileComposer.input"), "mobile-composer-label");
  label.htmlFor = "mobile-composer-input";
  const textarea = element("textarea", "", "mobile-composer-input");
  textarea.id = "mobile-composer-input";
  textarea.rows = 7;
  textarea.spellcheck = false;
  textarea.autocomplete = "off";
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("aria-describedby", "mobile-composer-hint mobile-composer-status");
  textarea.addEventListener("input", handlers.input);

  const hint = element("p", tr("mobileComposer.hint"), "mobile-composer-hint");
  hint.id = "mobile-composer-hint";
  const status = element("p", "", "mobile-composer-status");
  status.id = "mobile-composer-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = element("div", "", "mobile-composer-actions");
  const insert = element("button", tr("mobileComposer.insert"), "command-button");
  insert.type = "button";
  insert.addEventListener("click", () => handlers.submit(false));
  const send = element("button", tr("mobileComposer.send"), "command-button primary");
  send.type = "button";
  send.addEventListener("click", () => handlers.submit(true));
  const discard = element("button", tr("mobileComposer.discard"), "command-button mobile-composer-discard");
  discard.type = "button";
  discard.addEventListener("click", handlers.discard);
  actions.append(insert, send, discard);

  dialog.append(header, label, textarea, hint, status, actions);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    handlers.close();
  });
  for (const type of ["keydown", "keyup", "beforeinput", "paste", "compositionstart", "compositionend"]) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }
  document.body.append(dialog);

  function setBusy(busy: boolean) {
    dialog.setAttribute("aria-busy", String(busy));
    textarea.readOnly = busy;
    insert.disabled = busy;
    send.disabled = busy;
    discard.disabled = busy;
  }

  function setAvailable(available: boolean) {
    textarea.disabled = !available;
    if (!available) {
      insert.disabled = true;
      send.disabled = true;
      discard.disabled = true;
    }
  }

  function syncViewport() {
    const viewport = window.visualViewport;
    if (!viewport || !dialog.open) return;
    dialog.dataset.compact = String(viewport.height < 460);
    dialog.style.setProperty("--mobile-composer-viewport-height", `${Math.max(160, viewport.height)}px`);
    dialog.style.setProperty(
      "--mobile-composer-viewport-bottom",
      `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
    );
  }

  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);

  function destroy() {
    window.visualViewport?.removeEventListener("resize", syncViewport);
    window.visualViewport?.removeEventListener("scroll", syncViewport);
    dialog.remove();
  }

  return {
    dialog,
    target,
    textarea,
    status,
    close,
    insert,
    send,
    discard,
    setBusy,
    setAvailable,
    syncViewport,
    destroy,
  };
}
