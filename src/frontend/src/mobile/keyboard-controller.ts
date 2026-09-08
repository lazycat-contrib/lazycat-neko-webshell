import { createMobileKeyGestureController } from "./key-gesture-controller";
import type { MessageKey } from "../i18n";
import {
  mobileActionEventPhase,
  mobileActionRestoresKeyboard,
  mobileSyntheticActivation,
} from "./action-event-phase";
import {
  clearMobileSticky,
  createMobileStickyState,
  encodeMobileShortcutInput,
  isMobileModifierShortcut,
  mobileChordInput,
  toggleMobileModifier,
  transformMobileStickyInput,
} from "./shortcuts";
import {
  normalizeMobileQuickPhrases,
  renderMobileQuickPhraseKeyboardPanel,
  renderMobileQuickPhrasePageButton,
  renderMobileSymbolKeyboardPanel,
  type MobileSymbolAgent,
} from "./quick-input";
import type { MobileQuickPhrase } from "../types";
import { updateSystemKeyboardToggleState } from "./system-keyboard-state";
import type { MobileKeyboardLayout, MobileKeyboardPresetId } from "./keyboard-layout-types.ts";
import { renderMobileKeyboardPanels } from "./keyboard-layout-view.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type MobileShortcutRunOptions = {
  keepModifiers?: boolean;
};

export type MobileKeyboardControllerOptions = {
  root: HTMLElement;
  preserveSystemKeyboardState: () => () => void;
  onKeyInput: (data: string) => void;
  onPasteShortcut: () => Promise<void>;
  onAction: (action: string) => Promise<void>;
  onPhrase: (id: string) => Promise<void>;
};

export type MobileKeyboardRenderInput = {
  phrases: MobileQuickPhrase[];
  symbolAgent: MobileSymbolAgent;
  tr: Translate;
  layout: MobileKeyboardLayout;
  preset: MobileKeyboardPresetId;
};

export function createMobileKeyboardController(options: MobileKeyboardControllerOptions) {
  const sticky = createMobileStickyState();
  let gestures: ReturnType<typeof createMobileKeyGestureController<HTMLButtonElement>> | undefined;
  let disposed = false;
  let deferredActionTimer: number | undefined;
  const keyboardRestores = new WeakMap<HTMLButtonElement, () => void>();

  function captureKeyboardState(button: HTMLButtonElement): () => void {
    const restore = options.preserveSystemKeyboardState();
    keyboardRestores.set(button, restore);
    return restore;
  }

  function takeKeyboardRestore(button: HTMLButtonElement): () => void {
    const restore = keyboardRestores.get(button) ?? options.preserveSystemKeyboardState();
    keyboardRestores.delete(button);
    return restore;
  }

  function clearDeferredAction() {
    window.clearTimeout(deferredActionTimer);
    deferredActionTimer = undefined;
  }

  function activateButton(button: HTMLButtonElement, repeating: boolean) {
    const activation = mobileSyntheticActivation(button, 0);
    if (!activation) return;
    const restore = takeKeyboardRestore(button);
    if (activation.kind === "shortcut") void runShortcut(activation.value, { keepModifiers: repeating }, restore);
    else if (activation.kind === "chord") runChord(activation.value, restore);
    else if (activation.kind === "page") activatePage(activation.value);
    else if (activation.kind === "phrase") void runPhrase(activation.value, restore);
    else if (activation.kind === "text") runText(activation.value, button.dataset.mobileAutoEnter === "true", restore);
    else if (mobileActionEventPhase(activation.value) === "click") {
      // Open the pane menu after the physical click has bubbled, matching its
      // existing dismissal boundary. System-keyboard actions never defer.
      clearDeferredAction();
      deferredActionTimer = window.setTimeout(() => {
        deferredActionTimer = undefined;
        if (!disposed && options.root.contains(button)) void runAction(activation.value, restore);
      }, 0);
    } else void runAction(activation.value, restore);
  }

  function bind() {
    if (disposed || gestures) return;
    gestures = createMobileKeyGestureController<HTMLButtonElement>({
      root: options.root, globalTarget: window, visibilityTarget: document,
      button: (target) => {
        const button = target instanceof Element ? target.closest<HTMLButtonElement>("button") : null;
        return button && options.root.contains(button) && mobileSyntheticActivation(button, 0) ? button : undefined;
      },
      usable: (button) => options.root.contains(button) && !button.disabled && button.isConnected
        && button.getClientRects().length > 0,
      inside: (button, x, y) => {
        const rect = button.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      },
      repeat: (button) => button.dataset.mobileRepeat === "true" && Boolean(button.dataset.mobileShortcut),
      start: (button) => { clearDeferredAction(); captureKeyboardState(button); },
      activate: activateButton,
      finish: (button, repeated) => { keyboardRestores.delete(button); if (repeated) clearSticky(); },
      capture: (button, id) => button.setPointerCapture?.(id),
      release: (button, id) => { if (button.hasPointerCapture?.(id)) button.releasePointerCapture(id); },
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (timer) => window.clearTimeout(timer),
    });
    updateShortcutState();
  }

  function renderQuickInput(input: MobileKeyboardRenderInput): MobileQuickPhrase[] {
    stopRepeatInput();
    clearDeferredAction();
    const pages = options.root.querySelector<HTMLElement>(".mobile-keyboard-pages");
    const pageTabs = options.root.querySelector<HTMLElement>(".mobile-keyboard-page-tabs");
    const controls = options.root.querySelector<HTMLElement>(".mobile-keyboard-controls");
    if (!pages || !pageTabs || !controls) return input.phrases;
    const currentPage = activePage();
    controls.innerHTML = `${renderMobileKeyboardPanels(input.layout)}<div class="mobile-keyboard-panel" data-mobile-panel="phrases" hidden></div>`;
    updateShortcutState();
    const symPanel = controls.querySelector<HTMLElement>("[data-mobile-panel='sym']");
    const phrasePanel = controls.querySelector<HTMLElement>("[data-mobile-panel='phrases']");
    if (!symPanel || !phrasePanel) return input.phrases;

    const phraseButton = pages.querySelector<HTMLElement>("[data-mobile-page='phrases']");
    phraseButton?.remove();
    const phrases = normalizeMobileQuickPhrases(input.phrases);
    const phraseButtonHtml = renderMobileQuickPhrasePageButton(phrases, input.tr);
    if (phraseButtonHtml) {
      pageTabs.insertAdjacentHTML("beforeend", phraseButtonHtml);
    } else if (!phrasePanel.hidden) {
      activatePage("sym");
    }

    if (input.preset !== "custom") symPanel.innerHTML = renderMobileSymbolKeyboardPanel(input.symbolAgent);
    phrasePanel.innerHTML = renderMobileQuickPhraseKeyboardPanel(phrases);
    activatePage(currentPage === "phrases" && !phrases.length ? "sym" : currentPage);
    return phrases;
  }

  function activatePage(page: string) {
    if (!page) return;
    options.root.querySelectorAll<HTMLButtonElement>("[data-mobile-page]").forEach((button) => {
      const active = button.dataset.mobilePage === page;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    options.root.querySelectorAll<HTMLElement>("[data-mobile-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.mobilePanel !== page;
    });
  }

  function activePage(): string {
    return options.root.querySelector<HTMLButtonElement>("[data-mobile-page].active")?.dataset.mobilePage ?? "main";
  }

  async function runShortcut(
    shortcut: string,
    runOptions: MobileShortcutRunOptions,
    restoreKeyboard: () => void,
  ) {
    if (isMobileModifierShortcut(shortcut)) {
      toggleMobileModifier(sticky, shortcut);
      updateShortcutState();
      restoreKeyboard();
      return;
    }

    if (shortcut === "paste") {
      await options.onPasteShortcut();
      if (disposed) return;
      clearSticky();
      restoreKeyboard();
      return;
    }

    const data = encodeMobileShortcutInput(shortcut, sticky);
    if (data) {
      options.onKeyInput(data);
    }
    if (!runOptions.keepModifiers) {
      clearSticky();
    }
    restoreKeyboard();
  }

  function runChord(chord: string, restoreKeyboard: () => void) {
    const data = mobileChordInput(chord);
    if (data) {
      options.onKeyInput(data);
    }
    clearSticky();
    restoreKeyboard();
  }

  function runText(text: string, autoEnter: boolean, restoreKeyboard: () => void) {
    if (text) options.onKeyInput(autoEnter ? `${text}\r` : text);
    clearSticky();
    restoreKeyboard();
  }

  async function runPhrase(id: string, restoreKeyboard: () => void) {
    await options.onPhrase(id);
    if (!disposed) restoreKeyboard();
  }

  async function runAction(action: string, restoreKeyboard: () => void) {
    await options.onAction(action);
    if (disposed) return;
    clearSticky();
    if (mobileActionRestoresKeyboard(action)) restoreKeyboard();
  }

  function stopRepeatInput() {
    gestures?.cancel();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearDeferredAction();
    gestures?.dispose();
    gestures = undefined;
  }

  function encodeStickyInput(text: string, source: string): string | undefined {
    const encoded = transformMobileStickyInput(sticky, text, source);
    if (encoded) updateShortcutState();
    return encoded;
  }

  function clearSticky() {
    clearMobileSticky(sticky);
    updateShortcutState();
  }

  function updateShortcutState() {
    options.root.querySelectorAll<HTMLButtonElement>("[data-mobile-modifier]").forEach((button) => {
      const modifier = button.dataset.mobileModifier;
      const active = modifier === "ctrl" || modifier === "alt" || modifier === "shift" ? sticky[modifier] : false;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function updateSystemKeyboardState(enabled: boolean) {
    const button = options.root.querySelector<HTMLButtonElement>("[data-mobile-action='toggle-system-keyboard']");
    if (!button) return;
    updateSystemKeyboardToggleState(button, enabled);
  }

  return {
    bind,
    dispose,
    renderQuickInput,
    activatePage,
    stopRepeatInput,
    encodeStickyInput,
    clearSticky,
    updateShortcutState,
    updateSystemKeyboardState,
  };
}
