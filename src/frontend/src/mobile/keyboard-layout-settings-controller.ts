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
  moveMobileKeyboardKeyToIndex,
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
  const pageTabs = options.root.querySelector<HTMLElement>("[data-mobile-layout-page-tabs]");
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
  const enterHelp = options.root.querySelector<HTMLElement>("[data-mobile-key-enter-help]");
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
    pageTabs?.querySelectorAll<HTMLButtonElement>("[data-mobile-layout-page-tab]").forEach((tab) => {
      const selected = tab.dataset.mobileLayoutPageTab === pageId;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    list?.setAttribute("aria-labelledby", `mobileLayoutPageTab${pageId.charAt(0).toUpperCase()}${pageId.slice(1)}`);
    if (!list) return;
    const keys = currentLayout().pages.find((item) => item.id === pageId)?.keys ?? [];
    list.innerHTML = keys.length ? keys.map((key, index) => `
      <div class="mobile-keyboard-key-row${key.hidden ? " is-hidden" : ""}" data-mobile-layout-key="${escapeAttr(key.id)}" data-mobile-key-width="${escapeAttr(key.width)}" draggable="true">
        <div class="mobile-keyboard-key-card">
          <div class="mobile-keyboard-key-card-head">
            <span class="mobile-keyboard-drag-handle" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>
            <button type="button" class="mobile-keyboard-key-preview" data-mobile-key-visibility="${escapeAttr(key.id)}" aria-pressed="${!key.hidden}" aria-label="${escapeAttr(options.tr(key.hidden ? "action.show" : "action.hide"))}">
              ${key.icon ? `<i data-lucide="${escapeAttr(key.icon)}"></i>` : ""}<span>${escapeHtml(key.label || key.value)}</span>${key.autoEnter ? '<small aria-hidden="true">↵</small>' : ""}
            </button>
          </div>
          <span class="mobile-keyboard-key-meta">${escapeHtml(key.ariaLabel || key.label || key.value)}</span>
        </div>
        <div class="mobile-keyboard-key-controls">
          <label class="mobile-keyboard-key-width-control"><span>${escapeHtml(options.tr("field.mobileKeyboardKeyWidth"))}</span><select data-mobile-key-width="${escapeAttr(key.id)}" aria-label="${escapeAttr(options.tr("field.mobileKeyboardKeyWidth"))}">
            <option value="sm"${key.width === "sm" ? " selected" : ""}>${escapeHtml(options.tr("option.mobileKeyboardWidthSmall"))}</option><option value="md"${key.width === "md" ? " selected" : ""}>${escapeHtml(options.tr("option.mobileKeyboardWidthMedium"))}</option><option value="lg"${key.width === "lg" ? " selected" : ""}>${escapeHtml(options.tr("option.mobileKeyboardWidthLarge"))}</option>
          </select></label>
          <button type="button" class="icon-button" data-mobile-key-move="${escapeAttr(key.id)}" data-direction="-1" aria-label="${escapeAttr(options.tr("action.moveUp"))}"${index === 0 ? " disabled" : ""}><i data-lucide="chevron-up"></i></button>
          <button type="button" class="icon-button" data-mobile-key-move="${escapeAttr(key.id)}" data-direction="1" aria-label="${escapeAttr(options.tr("action.moveDown"))}"${index === keys.length - 1 ? " disabled" : ""}><i data-lucide="chevron-down"></i></button>
          ${key.custom ? `<button type="button" class="icon-button danger" data-mobile-key-remove="${escapeAttr(key.id)}" aria-label="${escapeAttr(options.tr("action.remove"))}"><i data-lucide="trash-2"></i></button>` : ""}
        </div>
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
      if (enterHelp) enterHelp.hidden = selected !== "text";
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
    pageTabs?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-mobile-layout-page-tab]") : null;
      const nextPage = target?.dataset.mobileLayoutPageTab as MobileKeyboardPageId | undefined;
      if (nextPage && MOBILE_KEYBOARD_PAGE_IDS.includes(nextPage)) {
        pageId = nextPage;
        render();
      }
    });
    pageTabs?.addEventListener("keydown", (event) => {
      if (!(event.target instanceof HTMLButtonElement)) return;
      const tabs = [...pageTabs.querySelectorAll<HTMLButtonElement>("[data-mobile-layout-page-tab]")];
      const current = tabs.indexOf(event.target);
      if (current < 0 || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const next = tabs[(current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      next?.click();
      next?.focus();
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
    options.root.addEventListener("dragstart", (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mobile-layout-key]") : null;
      if (!row) return;
      row.classList.add("is-dragging");
      event.dataTransfer?.setData("text/plain", row.dataset.mobileLayoutKey ?? "");
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    options.root.addEventListener("dragend", (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mobile-layout-key]") : null;
      row?.classList.remove("is-dragging");
      list?.querySelectorAll(".is-drag-over").forEach((item) => item.classList.remove("is-drag-over"));
    });
    options.root.addEventListener("dragover", (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mobile-layout-key]") : null;
      if (!row) return;
      event.preventDefault();
      list?.querySelectorAll(".is-drag-over").forEach((item) => item.classList.remove("is-drag-over"));
      row.classList.add("is-drag-over");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    options.root.addEventListener("drop", (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mobile-layout-key]") : null;
      if (!row) return;
      event.preventDefault();
      const sourceId = event.dataTransfer?.getData("text/plain") ?? "";
      const targetId = row.dataset.mobileLayoutKey ?? "";
      const keys = currentLayout().pages.find((item) => item.id === pageId)?.keys ?? [];
      const sourceIndex = keys.findIndex((item) => item.id === sourceId);
      const targetIndex = keys.findIndex((item) => item.id === targetId);
      const insertIndex = sourceIndex >= 0 && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      if (sourceId && targetIndex >= 0) commit(moveMobileKeyboardKeyToIndex(currentLayout(), pageId, sourceId, insertIndex));
    });
    let pointerDragKeyId = "";
    let pointerDragTargetId = "";
    const clearPointerDrag = () => {
      if (!pointerDragKeyId) return;
      list?.querySelectorAll(".is-dragging, .is-drag-over").forEach((item) => item.classList.remove("is-dragging", "is-drag-over"));
      pointerDragKeyId = "";
      pointerDragTargetId = "";
    };
    options.root.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") return;
      const handle = event.target instanceof Element ? event.target.closest<HTMLElement>(".mobile-keyboard-drag-handle") : null;
      const row = handle?.closest<HTMLElement>("[data-mobile-layout-key]");
      if (!row?.dataset.mobileLayoutKey) return;
      pointerDragKeyId = row.dataset.mobileLayoutKey;
      pointerDragTargetId = pointerDragKeyId;
      row.classList.add("is-dragging");
      row.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    options.root.addEventListener("pointermove", (event) => {
      if (!pointerDragKeyId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-mobile-layout-key]");
      if (!target || target.dataset.mobileLayoutKey === pointerDragKeyId) return;
      list?.querySelectorAll(".is-drag-over").forEach((item) => item.classList.remove("is-drag-over"));
      target.classList.add("is-drag-over");
      pointerDragTargetId = target.dataset.mobileLayoutKey ?? pointerDragKeyId;
    });
    options.root.addEventListener("pointerup", () => {
      if (!pointerDragKeyId) return;
      const keys = currentLayout().pages.find((item) => item.id === pageId)?.keys ?? [];
      const sourceIndex = keys.findIndex((item) => item.id === pointerDragKeyId);
      const targetIndex = keys.findIndex((item) => item.id === pointerDragTargetId);
      const insertIndex = sourceIndex >= 0 && sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      if (targetIndex >= 0) commit(moveMobileKeyboardKeyToIndex(currentLayout(), pageId, pointerDragKeyId, insertIndex));
      clearPointerDrag();
    });
    options.root.addEventListener("pointercancel", clearPointerDrag);
    render();
  }

  return { bind, render };
}

function actionLabel(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
