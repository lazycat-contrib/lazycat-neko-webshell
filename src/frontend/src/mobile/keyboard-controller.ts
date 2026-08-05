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
};

export function createMobileKeyboardController(options: MobileKeyboardControllerOptions) {
  const sticky = createMobileStickyState();
  let repeatTimer: number | undefined;
  let repeatInterval: number | undefined;
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

  function scheduleDeferredAction(action: string, button: HTMLButtonElement) {
    clearDeferredAction();
    deferredActionTimer = window.setTimeout(() => {
      deferredActionTimer = undefined;
      void runAction(action, takeKeyboardRestore(button));
    }, 0);
  }

  function bind() {
    options.root.addEventListener("pointerdown", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button")
        : null;
      if (button) captureKeyboardState(button);
    }, true);

    options.root.addEventListener("pointerdown", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-mobile-shortcut]")
        : null;
      if (!button || button.dataset.mobileRepeat === "true") return;
      event.preventDefault();
      void runShortcut(button.dataset.mobileShortcut ?? "", {}, takeKeyboardRestore(button));
    });

    options.root.addEventListener("click", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button")
        : null;
      const actionButton = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-mobile-action]")
        : null;
      if (
        event.target instanceof Element
        && event.target.closest("[data-mobile-shortcut], [data-mobile-action], [data-mobile-chord], [data-mobile-page], [data-mobile-phrase]")
      ) {
        event.preventDefault();
      }
      const action = actionButton?.dataset.mobileAction ?? "";
      if (mobileActionEventPhase(action) === "click") {
        clearDeferredAction();
        if (!actionButton) return;
        const restore = takeKeyboardRestore(actionButton);
        queueMicrotask(() => void runAction(action, restore));
        return;
      }
      if (!button) return;
      const activation = mobileSyntheticActivation(button, event.detail);
      if (!activation) return;
      const restore = takeKeyboardRestore(button);
      if (activation.kind === "shortcut") void runShortcut(activation.value, {}, restore);
      else if (activation.kind === "chord") runChord(activation.value, restore);
      else if (activation.kind === "page") activatePage(activation.value);
      else if (activation.kind === "phrase") void runPhrase(activation.value, restore);
      else if (activation.kind === "action") void runAction(activation.value, restore);
    });

    options.root.addEventListener("pointerdown", (event) => {
      const chordButton = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-mobile-chord]")
        : null;
      if (chordButton) {
        event.preventDefault();
        runChord(chordButton.dataset.mobileChord ?? "", takeKeyboardRestore(chordButton));
        return;
      }
      const actionButton = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-mobile-action]")
        : null;
      if (!actionButton) return;
      event.preventDefault();
      const action = actionButton.dataset.mobileAction ?? "";
      if (mobileActionEventPhase(action) === "pointerdown") {
        void runAction(action, takeKeyboardRestore(actionButton));
      } else {
        clearDeferredAction();
      }
    });

    options.root.addEventListener("pointerup", (event) => {
      const actionButton = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-mobile-action]")
        : null;
      const action = actionButton?.dataset.mobileAction ?? "";
      if (mobileActionEventPhase(action) === "pointerup") {
        event.preventDefault();
        clearDeferredAction();
        if (actionButton) void runAction(action, takeKeyboardRestore(actionButton));
        return;
      }
      if (mobileActionEventPhase(action) !== "click") return;
      event.preventDefault();
      if (actionButton) scheduleDeferredAction(action, actionButton);
    });

    options.root.addEventListener("pointerdown", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-mobile-phrase]")
        : null;
      if (!button) return;
      event.preventDefault();
      void runPhrase(button.dataset.mobilePhrase ?? "", takeKeyboardRestore(button));
    });

    options.root.addEventListener("pointerdown", (event) => {
      const button = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-mobile-page]")
        : null;
      if (!button) return;
      event.preventDefault();
      takeKeyboardRestore(button);
      activatePage(button.dataset.mobilePage ?? "");
    });

    options.root.querySelectorAll<HTMLButtonElement>("[data-mobile-repeat='true']").forEach((button) => {
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        const shortcut = button.dataset.mobileShortcut ?? "";
        void runShortcut(shortcut, { keepModifiers: true }, takeKeyboardRestore(button));
        window.clearTimeout(repeatTimer);
        window.clearInterval(repeatInterval);
        repeatTimer = window.setTimeout(() => {
          repeatInterval = window.setInterval(() => {
            void runShortcut(shortcut, { keepModifiers: true }, options.preserveSystemKeyboardState());
          }, 86);
        }, 360);
      });
      const stopRepeat = () => {
        stopRepeatInput();
        clearSticky();
      };
      button.addEventListener("pointerup", stopRepeat);
      button.addEventListener("pointercancel", stopRepeat);
      button.addEventListener("lostpointercapture", stopRepeat);
    });
    updateShortcutState();
  }

  function renderQuickInput(input: MobileKeyboardRenderInput): MobileQuickPhrase[] {
    const pages = options.root.querySelector<HTMLElement>(".mobile-keyboard-pages");
    const pageTabs = options.root.querySelector<HTMLElement>(".mobile-keyboard-page-tabs");
    const symPanel = options.root.querySelector<HTMLElement>("[data-mobile-panel='sym']");
    const phrasePanel = options.root.querySelector<HTMLElement>("[data-mobile-panel='phrases']");
    if (!pages || !pageTabs || !symPanel || !phrasePanel) return input.phrases;
    const currentPage = activePage();

    const phraseButton = pages.querySelector<HTMLElement>("[data-mobile-page='phrases']");
    phraseButton?.remove();
    const phrases = normalizeMobileQuickPhrases(input.phrases);
    const phraseButtonHtml = renderMobileQuickPhrasePageButton(phrases, input.tr);
    if (phraseButtonHtml) {
      pageTabs.insertAdjacentHTML("beforeend", phraseButtonHtml);
    } else if (!phrasePanel.hidden) {
      activatePage("sym");
    }

    symPanel.innerHTML = renderMobileSymbolKeyboardPanel(input.symbolAgent);
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

  async function runPhrase(id: string, restoreKeyboard: () => void) {
    await options.onPhrase(id);
    restoreKeyboard();
  }

  async function runAction(action: string, restoreKeyboard: () => void) {
    await options.onAction(action);
    clearSticky();
    if (mobileActionRestoresKeyboard(action)) restoreKeyboard();
  }

  function stopRepeatInput() {
    window.clearTimeout(repeatTimer);
    window.clearInterval(repeatInterval);
    repeatTimer = undefined;
    repeatInterval = undefined;
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
    renderQuickInput,
    activatePage,
    stopRepeatInput,
    encodeStickyInput,
    clearSticky,
    updateShortcutState,
    updateSystemKeyboardState,
  };
}
