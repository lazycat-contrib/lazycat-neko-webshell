import type { MessageKey } from "../i18n";
import {
  MAX_MOBILE_QUICK_PHRASES,
  makeMobileQuickPhrase,
  normalizeMobileQuickPhrases,
  renderMobileQuickPhraseList,
} from "./quick-input";
import type { MobileQuickPhrase, Tone } from "../types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type MobileQuickPhraseEditorElements = {
  mobileQuickPhraseList: HTMLElement;
  mobileQuickPhraseSave: HTMLButtonElement;
  mobileQuickPhraseCancel: HTMLButtonElement;
  mobileQuickPhraseLabel: HTMLInputElement;
  mobileQuickPhraseText: HTMLTextAreaElement;
  mobileQuickPhraseStatus: HTMLElement;
};

export type MobileQuickPhraseSaveResult =
  | { ok: true; phrases: MobileQuickPhrase[] }
  | { ok: false; message: MessageKey; values?: Record<string, string | number>; tone: Tone };

export function createMobileQuickPhraseEditor(elements: MobileQuickPhraseEditorElements) {
  let editingId = "";

  function render(phrases: MobileQuickPhrase[], tr: Translate) {
    elements.mobileQuickPhraseList.innerHTML = renderMobileQuickPhraseList(phrases, tr);
    elements.mobileQuickPhraseSave.textContent = editingId
      ? tr("action.quickPhraseSave")
      : tr("action.quickPhraseAdd");
    elements.mobileQuickPhraseCancel.hidden = !editingId;
  }

  function beginEdit(id: string, phrases: MobileQuickPhrase[], tr: Translate): boolean {
    const phrase = phrases.find((item) => item.id === id);
    if (!phrase) return false;
    editingId = phrase.id;
    elements.mobileQuickPhraseLabel.value = phrase.label;
    elements.mobileQuickPhraseText.value = phrase.text;
    clearStatus();
    render(phrases, tr);
    elements.mobileQuickPhraseText.focus();
    return true;
  }

  function reset(phrases: MobileQuickPhrase[], tr: Translate) {
    editingId = "";
    elements.mobileQuickPhraseLabel.value = "";
    elements.mobileQuickPhraseText.value = "";
    clearStatus();
    render(phrases, tr);
  }

  function save(phrases: MobileQuickPhrase[]): MobileQuickPhraseSaveResult {
    const text = elements.mobileQuickPhraseText.value.trim();
    if (!text) {
      return { ok: false, message: "validation.quickPhraseText", tone: "error" };
    }
    const existingIndex = phrases.findIndex((phrase) => phrase.id === editingId);
    const phrase = makeMobileQuickPhrase({
      id: existingIndex >= 0 ? editingId : undefined,
      label: elements.mobileQuickPhraseLabel.value,
      text,
    }, phrases);
    const current = existingIndex >= 0 ? phrases[existingIndex] : undefined;
    const next = {
      ...phrase,
      useCount: current?.useCount ?? 0,
      lastUsedAt: current?.lastUsedAt ?? 0,
    };
    if (existingIndex >= 0) {
      return {
        ok: true,
        phrases: normalizeMobileQuickPhrases(phrases.map((item) => item.id === editingId ? next : item)),
      };
    }
    if (phrases.length >= MAX_MOBILE_QUICK_PHRASES) {
      return {
        ok: false,
        message: "validation.quickPhraseLimit",
        values: { count: MAX_MOBILE_QUICK_PHRASES },
        tone: "error",
      };
    }
    return { ok: true, phrases: normalizeMobileQuickPhrases([...phrases, next]) };
  }

  function remove(id: string, phrases: MobileQuickPhrase[]): MobileQuickPhrase[] | undefined {
    const next = phrases.filter((phrase) => phrase.id !== id);
    if (next.length === phrases.length) return undefined;
    if (editingId === id) {
      editingId = "";
      elements.mobileQuickPhraseLabel.value = "";
      elements.mobileQuickPhraseText.value = "";
      clearStatus();
    }
    return normalizeMobileQuickPhrases(next);
  }

  function setStatus(message: string, tone: Tone = "neutral") {
    elements.mobileQuickPhraseStatus.textContent = message;
    elements.mobileQuickPhraseStatus.dataset.tone = tone;
  }

  function clearStatus() {
    elements.mobileQuickPhraseStatus.textContent = "";
  }

  return {
    render,
    beginEdit,
    reset,
    save,
    remove,
    setStatus,
  };
}
