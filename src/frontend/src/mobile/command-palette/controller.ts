import type { MessageKey } from "../../i18n.ts";
import type { MobileQuickPhrase } from "../../types.ts";
import type { MobileInputTarget } from "../input-target.ts";
import type { MobileKeyboardKey } from "../keyboard-layout-types.ts";
import {
  choicesForTab,
  MobilePaletteOperationLock,
  operationOwnsView,
  resolveActivationTarget,
  resolveCurrentChoice,
  type MobilePaletteChoice,
  type MobilePaletteTab,
} from "./model.ts";
import { createMobileCommandPaletteView } from "./view.ts";

type Options = {
  target: () => MobileInputTarget | undefined;
  isCurrent: (target: MobileInputTarget) => boolean;
  phrases: () => MobileQuickPhrase[];
  keys: () => MobileKeyboardKey[];
  sendPhrase: (target: MobileInputTarget, phraseId: string) => Promise<boolean>;
  sendKey: (target: MobileInputTarget, key: MobileKeyboardKey) => Promise<boolean>;
  prepare: () => void;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
};

export function createMobileCommandPalette(options: Options) {
  const operationLock = new MobilePaletteOperationLock();
  let view: ReturnType<typeof createMobileCommandPaletteView> | undefined;
  let captured: MobileInputTarget | undefined;
  let restoreFocus: HTMLElement | undefined;
  let tab: MobilePaletteTab = "recent";
  let query = "";
  let viewGeneration = 0;
  let disposed = false;

  function ensureView() {
    if (view) return view;
    view = createMobileCommandPaletteView(options.tr, {
      close,
      search: updateSearch,
      clear: clearSearch,
      selectTab,
      activate: (choice) => void activate(choice),
    });
    return view;
  }

  function status(key?: MessageKey) {
    if (view) view.status.textContent = key ? options.tr(key) : "";
  }

  function failureMessage(error?: unknown) {
    if (!view) return;
    view.status.textContent = error instanceof Error && error.message
      ? error.message
      : options.tr("mobilePalette.failed");
  }

  function emptyKey(choices: readonly MobilePaletteChoice[]): MessageKey {
    if (choices.length) return "mobilePalette.noMatches";
    if (query.trim()) return "mobilePalette.noMatches";
    if (tab === "recent") return "mobilePalette.noRecent";
    return "mobilePalette.empty";
  }

  function render() {
    if (!view) return;
    const choices = choicesForTab(options.phrases(), options.keys(), tab, query);
    view.render(choices, tab, emptyKey(choices), Boolean(captured));
    view.clear.disabled = operationLock.busy || !query;
  }

  function open() {
    if (disposed) return;
    const next = options.target();
    if (view?.dialog.open) close(false);
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    options.prepare();
    const currentView = ensureView();
    captured = next;
    tab = "recent";
    query = "";
    viewGeneration += 1;
    currentView.search.value = "";
    currentView.target.textContent = next?.label ?? "";
    currentView.setBusy(operationLock.busy);
    render();
    status(operationLock.busy
      ? "mobilePalette.sending"
      : next ? undefined : "mobilePalette.unavailable");
    currentView.dialog.showModal();
    currentView.syncViewport();
    currentView.close.focus({ preventScroll: true });
  }

  function close(restore = true) {
    if (!view?.dialog.open) return;
    viewGeneration += 1;
    captured = undefined;
    query = "";
    view.dialog.close();
    if (restore && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    restoreFocus = undefined;
  }

  function updateSearch() {
    if (!view || operationLock.busy) return;
    query = view.search.value;
    status();
    render();
  }

  function clearSearch() {
    if (!view || operationLock.busy || !query) return;
    query = "";
    view.search.value = "";
    status();
    render();
    view.search.focus({ preventScroll: true });
  }

  function selectTab(next: MobilePaletteTab) {
    if (operationLock.busy || tab === next) return;
    tab = next;
    status();
    render();
  }

  async function activate(displayed: MobilePaletteChoice) {
    if (!view || operationLock.busy || !captured) {
      if (view && !captured) status("mobilePalette.unavailable");
      return;
    }
    const target = resolveActivationTarget(captured, options.isCurrent);
    if (!target) {
      status("mobilePalette.unavailable");
      return;
    }
    const current = resolveCurrentChoice(displayed, options.phrases(), options.keys());
    if (!current) {
      render();
      status("mobilePalette.unavailable");
      return;
    }

    const operation = operationLock.begin();
    if (!operation) return;
    const generation = viewGeneration;
    view.setBusy(true);
    status("mobilePalette.sending");
    let succeeded = false;
    let failure: unknown;
    try {
      succeeded = current.kind === "phrase"
        ? await options.sendPhrase(target, current.phrase.id)
        : await options.sendKey(target, current.key as MobileKeyboardKey);
    } catch (error) {
      failure = error;
    }
    if (!operationLock.complete(operation)) return;
    const ownsView = operationOwnsView(generation, viewGeneration, target, captured);
    const currentView = view;
    if (!currentView?.dialog.open) return;
    currentView.setBusy(false);
    render();
    if (!ownsView) {
      status(captured ? undefined : "mobilePalette.unavailable");
      return;
    }
    if (succeeded) close();
    else failureMessage(failure);
  }

  function sync() {
    if (!view?.dialog.open) return;
    if (captured && !options.isCurrent(captured)) {
      close();
      return;
    }
    if (!operationLock.busy) render();
  }

  function ownsEvent(event: Event): boolean {
    return Boolean(view?.dialog.open && event.target instanceof Node && view.dialog.contains(event.target));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    close(false);
    view?.destroy();
    view = undefined;
  }

  return {
    open,
    close: () => close(),
    sync,
    isOpen: () => Boolean(view?.dialog.open),
    ownsEvent,
    dispose,
  };
}
