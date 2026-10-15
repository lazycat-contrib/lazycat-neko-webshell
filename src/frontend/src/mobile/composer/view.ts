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
  dialog.setAttribute("aria-describedby", "mobile-composer-target mobile-composer-hint mobile-composer-status");

  const header = element("header", "", "mobile-composer-head");
  const heading = element("div", "", "mobile-composer-heading");
  const title = element("h2", tr("mobileComposer.title"));
  title.id = "mobile-composer-title";
  const target = element("p", "", "mobile-composer-target");
  target.id = "mobile-composer-target";
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
  textarea.rows = 1;
  textarea.spellcheck = false;
  textarea.autocomplete = "off";
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("aria-describedby", "mobile-composer-hint mobile-composer-status");
  textarea.addEventListener("input", () => {
    handlers.input();
    resizeInput();
    scheduleReservedHeight();
  });

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
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      handlers.close();
    }
    event.stopPropagation();
  });
  for (const type of ["keyup", "beforeinput", "paste", "compositionstart", "compositionend"]) {
    dialog.addEventListener(type, (event) => event.stopPropagation());
  }
  document.body.append(dialog);

  const reservedHeightProperty = "--mobile-composer-reserved-height";
  let reservedHeight = 0;
  let reservationFrame = 0;

  function clearReservedHeight() {
    if (reservationFrame) window.cancelAnimationFrame(reservationFrame);
    reservationFrame = 0;
    reservedHeight = 0;
    document.body.style.removeProperty(reservedHeightProperty);
  }

  function updateReservedHeight() {
    if (!dialog.open || !dialog.isConnected) {
      clearReservedHeight();
      return;
    }
    const nextHeight = Math.ceil(dialog.getBoundingClientRect().height) + 16;
    if (nextHeight === reservedHeight) return;
    reservedHeight = nextHeight;
    document.body.style.setProperty(reservedHeightProperty, `${nextHeight}px`);
  }

  function scheduleReservedHeight() {
    if (reservationFrame) return;
    reservationFrame = window.requestAnimationFrame(() => {
      reservationFrame = 0;
      updateReservedHeight();
    });
  }

  const resizeObserver = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(scheduleReservedHeight);
  resizeObserver?.observe(dialog);
  dialog.addEventListener("close", () => {
    if (!dialog.open) clearReservedHeight();
  });

  function resizeInput() {
    textarea.style.height = "auto";
    const maxHeight = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
    const available = Number.isFinite(maxHeight) ? maxHeight : 112;
    textarea.style.height = `${Math.min(textarea.scrollHeight, available)}px`;
  }

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
    if (!dialog.open) return;
    if (viewport) {
      dialog.dataset.compact = String(viewport.height < 460);
      dialog.style.setProperty("--mobile-composer-viewport-height", `${Math.max(160, viewport.height)}px`);
      dialog.style.setProperty(
        "--mobile-composer-viewport-bottom",
        `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
      );
    }
    resizeInput();
    updateReservedHeight();
  }

  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);

  function destroy() {
    window.visualViewport?.removeEventListener("resize", syncViewport);
    window.visualViewport?.removeEventListener("scroll", syncViewport);
    resizeObserver?.disconnect();
    clearReservedHeight();
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
    clearReservedHeight,
    destroy,
  };
}
