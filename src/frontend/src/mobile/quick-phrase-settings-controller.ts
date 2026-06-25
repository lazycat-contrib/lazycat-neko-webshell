import type { MessageKey } from "../i18n";
import type { MobileQuickPhrase, Tone } from "../types";
import {
  createMobileQuickPhraseEditor,
  type MobileQuickPhraseEditorElements,
} from "./quick-phrase-editor";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type MobileQuickPhraseSettingsControllerOptions = {
  elements: MobileQuickPhraseEditorElements;
  phrases: () => MobileQuickPhrase[];
  setPhrases: (phrases: MobileQuickPhrase[]) => void;
  tr: Translate;
  saveSettings: () => void;
  updateIcons: () => void;
  onChanged: () => void;
};

export function createMobileQuickPhraseSettingsController(options: MobileQuickPhraseSettingsControllerOptions) {
  const editor = createMobileQuickPhraseEditor(options.elements);

  function render() {
    editor.render(options.phrases(), options.tr);
    options.updateIcons();
  }

  function setStatus(message: string, tone: Tone = "neutral") {
    editor.setStatus(message, tone);
  }

  return {
    render,
    beginEdit(id: string) {
      if (editor.beginEdit(id, options.phrases(), options.tr)) {
        options.updateIcons();
      }
    },
    reset() {
      editor.reset(options.phrases(), options.tr);
      options.updateIcons();
    },
    save() {
      const result = editor.save(options.phrases());
      if (!result.ok) {
        setStatus(options.tr(result.message, result.values), result.tone);
        return;
      }
      options.setPhrases(result.phrases);
      options.saveSettings();
      this.reset();
      options.onChanged();
      setStatus(options.tr("status.quickPhraseSaved"), "ok");
    },
    remove(id: string) {
      const phrases = editor.remove(id, options.phrases());
      if (!phrases) return;
      options.setPhrases(phrases);
      options.saveSettings();
      options.onChanged();
      setStatus(options.tr("status.quickPhraseRemoved"));
    },
    setStatus,
  };
}
