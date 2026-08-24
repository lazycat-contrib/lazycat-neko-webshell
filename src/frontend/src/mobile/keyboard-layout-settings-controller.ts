import type { MessageKey } from "../i18n.ts";
import type { MobileKeyboardKeyWidth, MobileKeyboardLayout, MobileKeyboardPageId, MobileKeyboardPresetId } from "./keyboard-layout-types.ts";
import { escapeAttr, escapeHtml } from "../utils.ts";
import {
  MOBILE_KEYBOARD_PAGE_IDS,
  MOBILE_KEYBOARD_ACTIONS,
  MAX_MOBILE_KEYS_PER_PAGE,
  addMobileKeyboardKey,
  mobileKeyboardPresetLayout,
  moveMobileKeyboardKey,
  removeMobileKeyboardKey,
  resolveMobileKeyboardLayout,
  updateMobileKeyboardKey,
} from "./keyboard-layout.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type Options = {
  root: HTMLElement;
  preset: () => MobileKeyboardPresetId;
  layout: () => MobileKeyboardLayout;
  setPreset: (preset: MobileKeyboardPresetId) => void;
  setLayout: (layout: MobileKeyboardLayout) => void;
  save: () => void;
  changed: () => void;
  updateIcons: () => void;
  tr: Translate;
};

export function createMobileKeyboardLayoutSettingsController(options: Options) {
  let pageId: MobileKeyboardPageId = "main";
  const preset = options.root.querySelector<HTMLSelectElement>("[data-mobile-layout-preset]");
  const page = options.root.querySelector<HTMLSelectElement>("[data-mobile-layout-page]");
  const list = options.root.querySelector<HTMLElement>("[data-mobile-layout-key-list]");
  const label = options.root.querySelector<HTMLInputElement>("[data-mobile-key-label]");
  const kind = options.root.querySelector<HTMLSelectElement>("[data-mobile-key-kind]");
  const text = options.root.querySelector<HTMLTextAreaElement>("[data-mobile-key-text]");
  const textField = options.root.querySelector<HTMLElement>("[data-mobile-key-text-field]");
  const valueField = options.root.querySelector<HTMLElement>("[data-mobile-key-value-field]");
  const value = options.root.querySelector<HTMLSelectElement>("[data-mobile-key-value]");
  const width = options.root.querySelector<HTMLSelectElement>("[data-mobile-key-new-width]");
  const enter = options.root.querySelector<HTMLInputElement>("[data-mobile-key-enter]");
  const enterField = options.root.querySelector<HTMLElement>("[data-mobile-key-enter-field]");
  const status = options.root.querySelector<HTMLElement>("[data-mobile-layout-status]");

  function currentLayout() {
    return resolveMobileKeyboardLayout(options.preset(), options.layout());
  }

  function commit(layout: MobileKeyboardLayout) {
    options.setLayout(layout);
    options.setPreset("custom");
    options.save();
    options.changed();
    render();
  }

  function render() {
    if (preset) preset.value = options.preset();
    if (page) page.value = pageId;
    if (!list) return;
    const keys = currentLayout().pages.find((item) => item.id === pageId)?.keys ?? [];
    list.innerHTML = keys.length ? keys.map((key, index) => `
      <div class="mobile-keyboard-key-row" data-mobile-layout-key="${escapeAttr(key.id)}">
        <button type="button" class="mobile-keyboard-key-preview" data-mobile-key-visibility="${escapeAttr(key.id)}" aria-pressed="${!key.hidden}" aria-label="${escapeAttr(options.tr(key.hidden ? "action.show" : "action.hide"))}">
          ${key.icon ? `<i data-lucide="${escapeAttr(key.icon)}"></i>` : ""}<span>${escapeHtml(key.label || key.value)}</span>${key.autoEnter ? '<small aria-hidden="true">↵</small>' : ""}
        </button>
        <select data-mobile-key-width="${escapeAttr(key.id)}" aria-label="${escapeAttr(options.tr("field.mobileKeyboardKeyWidth"))}">
          <option value="sm"${key.width === "sm" ? " selected" : ""}>S</option><option value="md"${key.width === "md" ? " selected" : ""}>M</option><option value="lg"${key.width === "lg" ? " selected" : ""}>L</option>
        </select>
        <button type="button" class="icon-button" data-mobile-key-move="${escapeAttr(key.id)}" data-direction="-1" aria-label="${escapeAttr(options.tr("action.moveUp"))}"${index === 0 ? " disabled" : ""}><i data-lucide="chevron-up"></i></button>
        <button type="button" class="icon-button" data-mobile-key-move="${escapeAttr(key.id)}" data-direction="1" aria-label="${escapeAttr(options.tr("action.moveDown"))}"${index === keys.length - 1 ? " disabled" : ""}><i data-lucide="chevron-down"></i></button>
        ${key.custom ? `<button type="button" class="icon-button danger" data-mobile-key-remove="${escapeAttr(key.id)}" aria-label="${escapeAttr(options.tr("action.remove"))}"><i data-lucide="trash-2"></i></button>` : ""}
      </div>
    `).join("") : `<p class="empty">${escapeHtml(options.tr("status.mobileKeyboardPageEmpty"))}</p>`;
    options.updateIcons();
  }

  function bind() {
    const refreshCustomKeyType = () => {
      const selected = kind?.value ?? "text";
      if (textField) textField.hidden = selected !== "text";
      if (valueField) valueField.hidden = selected === "text";
      if (enterField) enterField.hidden = selected !== "text";
      if (!value || selected === "text") return;
      const entries = selected === "action"
        ? MOBILE_KEYBOARD_ACTIONS.map((item) => [item, actionLabel(item)] as const)
        : [
          ["escape", "Esc"], ["tab", "Tab"], ["enter", "Return"], ["home", "Home"], ["end", "End"],
          ["pageUp", "PgUp"], ["pageDown", "PgDn"], ["insert", "Ins"], ["delete", "Del"], ["backspace", "Bksp"],
          ["left", "Left"], ["down", "Down"], ["up", "Up"], ["right", "Right"],
        ] as const;
      value.innerHTML = entries.map(([entryValue, entryLabel]) => `<option value="${escapeAttr(entryValue)}">${escapeHtml(entryLabel)}</option>`).join("");
    };
    kind?.addEventListener("change", refreshCustomKeyType);
    refreshCustomKeyType();
    preset?.addEventListener("change", () => {
      const value = preset.value as MobileKeyboardPresetId;
      if (value !== "default" && value !== "operations" && value !== "editor" && value !== "custom") return;
      options.setPreset(value);
      options.save();
      options.changed();
      render();
    });
    page?.addEventListener("change", () => {
      if (MOBILE_KEYBOARD_PAGE_IDS.includes(page.value as MobileKeyboardPageId)) pageId = page.value as MobileKeyboardPageId;
      render();
    });
    options.root.addEventListener("change", (event) => {
      const control = event.target instanceof Element ? event.target.closest<HTMLSelectElement>("[data-mobile-key-width]") : null;
      if (!control) return;
      commit(updateMobileKeyboardKey(currentLayout(), pageId, control.dataset.mobileKeyWidth ?? "", { width: control.value as MobileKeyboardKeyWidth }));
    });
    options.root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const move = target?.closest<HTMLButtonElement>("[data-mobile-key-move]");
      if (move) return commit(moveMobileKeyboardKey(currentLayout(), pageId, move.dataset.mobileKeyMove ?? "", move.dataset.direction === "-1" ? -1 : 1));
      const visibility = target?.closest<HTMLButtonElement>("[data-mobile-key-visibility]");
      if (visibility) {
        const id = visibility.dataset.mobileKeyVisibility ?? "";
        const key = currentLayout().pages.find((item) => item.id === pageId)?.keys.find((item) => item.id === id);
        if (key) commit(updateMobileKeyboardKey(currentLayout(), pageId, id, { hidden: !key.hidden }));
        return;
      }
      const remove = target?.closest<HTMLButtonElement>("[data-mobile-key-remove]");
      if (remove) return commit(removeMobileKeyboardKey(currentLayout(), pageId, remove.dataset.mobileKeyRemove ?? ""));
      if (target?.closest("[data-mobile-layout-reset]")) {
        options.setLayout(mobileKeyboardPresetLayout("default"));
        options.setPreset("default");
        options.save();
        options.changed();
        render();
        return;
      }
      if (!target?.closest("[data-mobile-key-add]")) return;
      const keyCount = currentLayout().pages.find((item) => item.id === pageId)?.keys.length ?? 0;
      if (keyCount >= MAX_MOBILE_KEYS_PER_PAGE) {
        if (status) {
          status.textContent = options.tr("validation.mobileKeyboardKeyLimit", { count: MAX_MOBILE_KEYS_PER_PAGE });
          status.dataset.tone = "error";
        }
        return;
      }
      const keyKind = kind?.value === "shortcut" || kind?.value === "action" ? kind.value : "text";
      const keyValue = keyKind === "text" ? text?.value ?? "" : value?.value ?? "";
      if (!keyValue) {
        if (status) {
          status.textContent = options.tr("validation.mobileKeyboardKeyText");
          status.dataset.tone = "error";
        }
        text?.focus();
        return;
      }
      commit(addMobileKeyboardKey(currentLayout(), pageId, {
        kind: keyKind,
        label: label?.value ?? "",
        value: keyValue,
        width: width?.value === "sm" || width?.value === "lg" ? width.value : "md",
        autoEnter: enter?.checked === true,
      }));
      if (label) label.value = "";
      if (text) text.value = "";
      if (enter) enter.checked = false;
      if (status) status.textContent = "";
    });
    render();
  }

  return { bind, render };
}

function actionLabel(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
