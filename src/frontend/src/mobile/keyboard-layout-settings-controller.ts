import type { MessageKey } from "../i18n.ts";
import type { MobileKeyboardKeyWidth, MobileKeyboardLayout, MobileKeyboardPageId, MobileKeyboardPresetId } from "./keyboard-layout-types.ts";
import { escapeAttr, escapeHtml } from "../utils.ts";
import {
  MOBILE_KEYBOARD_PAGE_IDS,
  mobileKeyboardPresetLayout,
  moveMobileKeyboardKey,
  moveMobileKeyboardKeyToIndex,
  removeMobileKeyboardKey,
  resolveMobileKeyboardLayout,
  updateMobileKeyboardKey,
} from "./keyboard-layout.ts";

import { createMobileKeyEditor } from "./settings/key-editor.ts";
import { renderMobileKeyboardKey } from "./keyboard-layout-view.ts";

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
  const preview = options.root.querySelector<HTMLElement>("[data-mobile-layout-preview]");
  const undo = options.root.querySelector<HTMLButtonElement>("[data-mobile-layout-undo]");
  let previous: { preset: MobileKeyboardPresetId; layout: MobileKeyboardLayout } | undefined;
  let editor: ReturnType<typeof createMobileKeyEditor> | undefined;

  function remember() {
    previous = { preset: options.preset(), layout: structuredClone(options.layout()) };
  }

  function currentLayout() {
    return resolveMobileKeyboardLayout(options.preset(), options.layout());
  }

  function commit(layout: MobileKeyboardLayout) {
    const focused = document.activeElement instanceof HTMLElement && list?.contains(document.activeElement) ? document.activeElement : undefined;
    const focusAttributes = focused ? [...focused.attributes].filter((attr) => attr.name.startsWith("data-mobile-key-") || attr.name === "data-direction") : [];
    remember();
    options.setLayout(layout);
    options.setPreset("custom");
    options.save();
    options.changed();
    render();
    if (focusAttributes.length) {
      const selector = focusAttributes.map((attr) => `[${attr.name}="${CSS.escape(attr.value)}"]`).join("");
      const replacement = list?.querySelector<HTMLElement>(selector);
      if (replacement && !replacement.matches(":disabled")) replacement.focus({ preventScroll: true });
      else undo?.focus({ preventScroll: true });
    }
  }

  function render() {
    if (undo) undo.disabled = !previous;
    if (preset) preset.value = options.preset();
    pageTabs?.querySelectorAll<HTMLButtonElement>("[data-mobile-layout-page-tab]").forEach((tab) => {
      const selected = tab.dataset.mobileLayoutPageTab === pageId;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    list?.setAttribute("aria-labelledby", `mobileLayoutPageTab${pageId.charAt(0).toUpperCase()}${pageId.slice(1)}`);
    if (!list) return;
    const keys = currentLayout().pages.find((item) => item.id === pageId)?.keys ?? [];
    if (preview) {
      const visible = keys.filter((key) => !key.hidden);
      preview.innerHTML = visible.length ? visible.map((key) => renderMobileKeyboardKey(key).replace("<button ", '<button tabindex="-1" aria-disabled="true" ')).join("") : `<p class="empty">${escapeHtml(options.tr("status.mobileKeyboardPageEmpty"))}</p>`;
    }
    list.innerHTML = keys.length ? keys.map((key, index) => `
      <div class="mobile-keyboard-key-row${key.hidden ? " is-hidden" : ""}" data-mobile-layout-key="${escapeAttr(key.id)}" data-mobile-key-width="${escapeAttr(key.width)}">
        <div class="mobile-keyboard-key-card">
          <div class="mobile-keyboard-key-card-head">
            <span class="mobile-keyboard-drag-handle" draggable="true" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>
            <button type="button" class="mobile-keyboard-key-preview" data-mobile-key-visibility="${escapeAttr(key.id)}" aria-pressed="${!key.hidden}" aria-label="${escapeAttr(options.tr(key.hidden ? "action.show" : "action.hide"))}">
              <i data-lucide="${key.hidden ? "eye-off" : "eye"}"></i>${key.icon ? `<i data-lucide="${escapeAttr(key.icon)}"></i>` : ""}<span>${escapeHtml(key.label || key.value)}</span>${key.autoEnter ? '<small aria-hidden="true">↵</small>' : ""}
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
          ${key.custom ? `<button type="button" class="icon-button" data-mobile-key-edit="${escapeAttr(key.id)}" aria-label="${escapeAttr(options.tr("action.mobileKeyboardEditKey"))}"><i data-lucide="pencil"></i></button><button type="button" class="icon-button danger" data-mobile-key-remove="${escapeAttr(key.id)}" aria-label="${escapeAttr(options.tr("action.remove"))}"><i data-lucide="trash-2"></i></button>` : ""}
        </div>
      </div>
    `).join("") : `<p class="empty">${escapeHtml(options.tr("status.mobileKeyboardPageEmpty"))}</p>`;
    options.updateIcons();
  }

  function bind() {
    editor = createMobileKeyEditor({ root: options.root, layout: currentLayout, page: () => pageId, commit, tr: options.tr });
    undo?.addEventListener("click", () => {
      if (!previous) return;
      const snapshot = previous;
      previous = undefined;
      editor?.reset();
      options.setLayout(snapshot.layout);
      options.setPreset(snapshot.preset);
      options.save();
      options.changed();
      render();
    });
    preset?.addEventListener("change", () => {
      const value = preset.value as MobileKeyboardPresetId;
      if (value !== "default" && value !== "operations" && value !== "editor" && value !== "custom") return;
      remember();
      editor?.reset();
      options.setPreset(value);
      options.save();
      options.changed();
      render();
    });
    pageTabs?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-mobile-layout-page-tab]") : null;
      const nextPage = target?.dataset.mobileLayoutPageTab as MobileKeyboardPageId | undefined;
      if (nextPage && MOBILE_KEYBOARD_PAGE_IDS.includes(nextPage)) {
        editor?.reset();
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
      const edit = target?.closest<HTMLButtonElement>("[data-mobile-key-edit]");
      if (edit) {
        const key = currentLayout().pages.find((item) => item.id === pageId)?.keys.find((item) => item.id === edit.dataset.mobileKeyEdit);
        if (key) editor?.edit(key);
        return;
      }
      const remove = target?.closest<HTMLButtonElement>("[data-mobile-key-remove]");
      if (remove) return commit(removeMobileKeyboardKey(currentLayout(), pageId, remove.dataset.mobileKeyRemove ?? ""));
      if (target?.closest("[data-mobile-layout-reset]")) {
        remember();
        editor?.reset();
        options.setLayout(mobileKeyboardPresetLayout("default"));
        options.setPreset("default");
        options.save();
        options.changed();
        render();
        return;
      }

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
      const targetIndex = keys.findIndex((item) => item.id === targetId);
      const insertIndex = targetIndex;
      if (sourceId && targetIndex >= 0) commit(moveMobileKeyboardKeyToIndex(currentLayout(), pageId, sourceId, insertIndex));
    });
    let pointerDragId: number | undefined;
    let pointerDragKeyId = "";
    let pointerDragTargetId = "";
    const clearPointerDrag = () => {
      if (!pointerDragKeyId) return;
      list?.querySelectorAll(".is-dragging, .is-drag-over").forEach((item) => item.classList.remove("is-dragging", "is-drag-over"));
      pointerDragKeyId = "";
      pointerDragTargetId = "";
      pointerDragId = undefined;
    };
    options.root.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" || !event.isPrimary || event.button !== 0 || pointerDragId !== undefined) return;
      const handle = event.target instanceof Element ? event.target.closest<HTMLElement>(".mobile-keyboard-drag-handle") : null;
      const row = handle?.closest<HTMLElement>("[data-mobile-layout-key]");
      if (!row?.dataset.mobileLayoutKey) return;
      pointerDragId = event.pointerId;
      pointerDragKeyId = row.dataset.mobileLayoutKey;
      pointerDragTargetId = pointerDragKeyId;
      row.classList.add("is-dragging");
      row.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    options.root.addEventListener("pointermove", (event) => {
      if (!pointerDragKeyId || event.pointerId !== pointerDragId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-mobile-layout-key]");
      if (!target || !list?.contains(target)) return;
      list?.querySelectorAll(".is-drag-over").forEach((item) => item.classList.remove("is-drag-over"));
      target.classList.add("is-drag-over");
      pointerDragTargetId = target.dataset.mobileLayoutKey ?? pointerDragKeyId;
    });
    options.root.addEventListener("pointerup", (event) => {
      if (!pointerDragKeyId || event.pointerId !== pointerDragId) return;
      const keys = currentLayout().pages.find((item) => item.id === pageId)?.keys ?? [];
      const targetIndex = keys.findIndex((item) => item.id === pointerDragTargetId);
      const insertIndex = targetIndex;
      if (targetIndex >= 0 && pointerDragKeyId !== pointerDragTargetId) commit(moveMobileKeyboardKeyToIndex(currentLayout(), pageId, pointerDragKeyId, insertIndex));
      clearPointerDrag();
    });
    options.root.addEventListener("pointercancel", clearPointerDrag);
    options.root.addEventListener("lostpointercapture", clearPointerDrag);
    render();
  }

  return { bind, render };
}
