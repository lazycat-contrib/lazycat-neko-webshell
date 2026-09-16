import type { MessageKey } from "../i18n";
import type { MobileQuickPhrase, TerminalPane } from "../types";
import type { MobileKeyboardKey } from "./keyboard-layout-types";
import { createMobileComposer } from "./composer/controller";
import { createMobileCommandPalette } from "./command-palette/controller";
import { createMobileInputDispatch } from "./input-dispatch";
import { sameMobileInputTarget, type MobileInputTarget } from "./input-target";
import { createMobileStickyState, encodeMobileShortcutInput, mobileChordInput } from "./shortcuts";

type Options = {
  target: () => MobileInputTarget | undefined;
  phrases: () => MobileQuickPhrase[];
  keys: () => MobileKeyboardKey[];
  phraseUsed: (id: string) => void;
  canWrite: (pane: TerminalPane) => boolean;
  sendBytes: (pane: TerminalPane, text: string) => boolean;
  nativeKey: (pane: TerminalPane, text: string) => boolean;
  ensureHerdr: (pane: TerminalPane) => Promise<string>;
  currentHerdrPane: (selector: string) => Promise<string>;
  sendHerdrInput: (selector: string, paneId: string, text: string, enter: boolean) => Promise<void>;
  sendHerdrKeys: (selector: string, paneId: string, keys: string[]) => Promise<void>;
  sendHerdrRaw: (selector: string, paneId: string, text: string) => Promise<void>;
  prepare: () => void;
  closeNavigation: () => void;
  cancelKeys: () => void;
  closeOverview: () => void;
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
};

export function createMobileExperience(options: Options) {
  const isCurrent = (target: MobileInputTarget) => sameMobileInputTarget(target, options.target());
  const dispatch = createMobileInputDispatch({ ...options, isCurrent, multilineError: () => options.tr("mobileComposer.multilineUnsupported") });
  const prepare = () => { options.closeNavigation(); options.cancelKeys(); options.closeOverview(); options.prepare(); };
  const composer = createMobileComposer({ target: options.target, isCurrent, send: dispatch.send, prepare, tr: options.tr });

  function keys() {
    const seen = new Set<string>();
    return options.keys().filter(key => {
      if (key.hidden || key.kind === "action" || (key.kind === "shortcut" && ["ctrl", "alt", "shift", "paste"].includes(key.value))) return false;
      const signature = JSON.stringify([key.kind, key.value, key.autoEnter]);
      if (seen.has(signature)) return false;
      seen.add(signature); return true;
    });
  }

  async function sendPhrase(target: MobileInputTarget, id: string) {
    const phrase = options.phrases().find(item => item.id === id);
    if (!phrase || !dispatch.writable(target)) return false;
    const sent = await dispatch.send(target, phrase.text, phrase.sendEnter);
    if (sent) options.phraseUsed(id);
    return sent;
  }

  async function sendKey(target: MobileInputTarget, key: MobileKeyboardKey): Promise<boolean> {
    const current = keys().find(item => item.id === key.id);
    if (!current || current.kind !== key.kind || current.value !== key.value || current.autoEnter !== key.autoEnter || !dispatch.writable(target)) return false;
    const data = key.kind === "text" ? `${key.value}${key.autoEnter ? "\r" : ""}`
      : key.kind === "chord" ? mobileChordInput(key.value)
      : encodeMobileShortcutInput(key.value, createMobileStickyState());
    if (!data) return false;
    if (!target.herdrPaneId) return options.nativeKey(target.pane, data);
    const selector = await options.ensureHerdr(target.pane);
    if (!dispatch.writable(target) || selector !== target.selector) return false;
    const paneId = await options.currentHerdrPane(selector);
    if (!dispatch.writable(target) || paneId !== target.herdrPaneId) return false;
    if (key.kind === "text") await options.sendHerdrRaw(selector, paneId, data);
    else if (key.kind === "shortcut" && key.value.length === 1) await options.sendHerdrInput(selector, paneId, key.value, false);
    else {
      const names: Record<string, string> = { "ctrl-c": "ctrl+c", "ctrl-e": "ctrl+e", "shift-tab": "shift+tab", pageUp: "pageup", pageDown: "pagedown", escape: "esc" };
      await options.sendHerdrKeys(selector, paneId, [names[key.value] ?? key.value]);
    }
    return true;
  }

  const palette = createMobileCommandPalette({ target: options.target, isCurrent, phrases: options.phrases, keys, sendPhrase, sendKey, prepare, tr: options.tr });
  let lastTarget: MobileInputTarget | undefined;
  function sync() {
    const target = options.target();
    if (lastTarget && !sameMobileInputTarget(lastTarget, target)) { options.closeNavigation(); options.cancelKeys(); }
    lastTarget = target;
    composer.sync(); palette.sync();
  }
  function close() { composer.close(); palette.close(); options.closeNavigation(); options.cancelKeys(); }
  return {
    openComposer() { palette.close(); composer.open(); },
    openPalette() { composer.close(); palette.open(); },
    sync, close,
    observe: dispatch.observe,
    ownsEvent: (event: Event) => composer.ownsEvent(event) || palette.ownsEvent(event),
    dispose() { composer.dispose(); palette.dispose(); },
  };
}
