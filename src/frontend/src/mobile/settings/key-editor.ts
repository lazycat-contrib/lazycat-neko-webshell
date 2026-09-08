import type { MessageKey } from "../../i18n.ts";
import type { MobileKeyboardKey, MobileKeyboardLayout, MobileKeyboardPageId } from "../keyboard-layout-types.ts";
import { addMobileKeyboardKey, editMobileKeyboardCustomKey, encodeMobileKeyboardText, MAX_MOBILE_KEYS_PER_PAGE, MAX_MOBILE_KEY_TEXT, mobileKeyboardTextError, MOBILE_KEYBOARD_ACTIONS } from "../keyboard-layout.ts";
import { escapeAttr, escapeHtml } from "../../utils.ts";

type Options = {
  root: HTMLElement;
  layout: () => MobileKeyboardLayout;
  page: () => MobileKeyboardPageId;
  commit: (layout: MobileKeyboardLayout) => void;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
};

export function createMobileKeyEditor(options: Options) {
  const query = <T extends HTMLElement>(name: string) => options.root.querySelector<T>(`[data-mobile-key-${name}]`);
  const label = query<HTMLInputElement>("label");
  const kind = query<HTMLSelectElement>("kind");
  const text = query<HTMLTextAreaElement>("text");
  const value = query<HTMLSelectElement>("value");
  const width = query<HTMLSelectElement>("new-width");
  const enter = query<HTMLInputElement>("enter");
  const add = query<HTMLButtonElement>("add");
  const cancel = query<HTMLButtonElement>("cancel");
  const title = query<HTMLElement>("editor-title");
  const status = options.root.querySelector<HTMLElement>("[data-mobile-layout-status]");
  let editing: { page: MobileKeyboardPageId; id: string } | undefined;
  let returnFocus: HTMLElement | undefined;

  function refreshType() {
    const selected = kind?.value ?? "text";
    for (const name of ["text-field", "enter-field", "enter-help"]) {
      const field = query(name);
      if (field) field.hidden = selected !== "text";
    }
    const field = query("value-field");
    if (field) field.hidden = selected === "text";
    if (!value || selected === "text") return;
    const entries = selected === "action"
      ? MOBILE_KEYBOARD_ACTIONS.map((item) => [item, item.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")])
      : selected === "chord" ? [["ctrl-c", "Ctrl+C"], ["ctrl-e", "Ctrl+E"], ["shift-tab", "Shift+Tab"]]
      : [
        ["escape", "Esc"], ["tab", "Tab"], ["enter", "Return"], ["home", "Home"], ["end", "End"],
        ["pageUp", "PgUp"], ["pageDown", "PgDn"], ["insert", "Ins"], ["delete", "Del"], ["backspace", "Bksp"],
        ["left", "Left"], ["down", "Down"], ["up", "Up"], ["right", "Right"],
        ["ctrl", "Ctrl"], ["alt", "Alt"], ["shift", "Shift"], ["paste", "Paste"],
        ...Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]),
      ];
    value.innerHTML = entries.map(([id, name]) => `<option value="${escapeAttr(id!)}">${escapeHtml(name!)}</option>`).join("");
  }

  function reset() {
    editing = undefined;
    if (label) label.value = "";
    if (text) text.value = "";
    if (enter) enter.checked = false;
    if (cancel) cancel.hidden = true;
    for (const node of [add, title]) {
      if (!node) continue;
      node.dataset.i18n = "action.mobileKeyboardAddKey";
      node.textContent = options.tr("action.mobileKeyboardAddKey");
    }
    if (status) status.textContent = "";
  }

  function edit(key: MobileKeyboardKey) {
    if (!key.custom) return;
    reset();
    editing = { page: options.page(), id: key.id };
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (kind) kind.value = key.kind;
    refreshType();
    if (label) label.value = key.label;
    if (text) text.value = encodeMobileKeyboardText(key.value);
    if (value && key.kind !== "text") {
      // Persisted layouts can contain a printable special key outside the picker.
      if (![...value.options].some((option) => option.value === key.value)) value.add(new Option(key.value, key.value));
      value.value = key.value;
    }
    if (width) width.value = key.width;
    if (enter) enter.checked = key.autoEnter;
    if (cancel) cancel.hidden = false;
    if (add) { add.dataset.i18n = "action.save"; add.textContent = options.tr("action.save"); }
    if (title) { title.dataset.i18n = "action.mobileKeyboardEditKey"; title.textContent = options.tr("action.mobileKeyboardEditKey"); }
    const details = title?.closest("details");
    if (details) details.open = true;
    label?.focus();
  }

  kind?.addEventListener("change", refreshType);
  cancel?.addEventListener("click", () => { reset(); if (returnFocus?.isConnected) returnFocus.focus(); });
  add?.addEventListener("click", () => {
    const layout = options.layout();
    const pageId = editing?.page ?? options.page();
    const keys = layout.pages.find((item) => item.id === pageId)?.keys ?? [];
    if (editing && !keys.some((key) => key.id === editing?.id && key.custom)) { reset(); return; }
    const error = !editing && keys.length >= MAX_MOBILE_KEYS_PER_PAGE
      ? options.tr("validation.mobileKeyboardKeyLimit", { count: MAX_MOBILE_KEYS_PER_PAGE }) : undefined;
    const keyKind = kind?.value === "shortcut" || kind?.value === "action" || kind?.value === "chord" ? kind.value : "text";
    const keyValue = keyKind === "text" ? text?.value ?? "" : value?.value ?? "";
    const textError = keyKind === "text" ? mobileKeyboardTextError(keyValue) : undefined;
    if (error || !keyValue || textError) {
      if (status) { status.textContent = error ?? (textError === "tooLong" ? options.tr("validation.mobileKeyboardKeyTooLong", { count: MAX_MOBILE_KEY_TEXT }) : options.tr("validation.mobileKeyboardKeyText")); status.dataset.tone = "error"; }
      if (!keyValue || textError) (keyKind === "text" ? text : value)?.focus();
      return;
    }
    const input = { kind: keyKind, label: label?.value ?? "", value: keyValue, width: width?.value === "sm" || width?.value === "lg" ? width.value : "md", autoEnter: keyKind === "text" && enter?.checked === true } as const;
    const next = editing ? editMobileKeyboardCustomKey(layout, pageId, editing.id, input) : addMobileKeyboardKey(layout, pageId, input);
    options.commit(next);
    reset();
    add?.focus({ preventScroll: true });
  });
  refreshType();
  return { edit, reset };
}
