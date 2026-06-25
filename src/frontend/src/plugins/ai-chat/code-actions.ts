import type { MessageKey } from "../../i18n";
import type { TerminalPane, Tone } from "../../types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type AIChatCodeSendDeps = {
  activePane: () => TerminalPane | undefined;
  sendText: (pane: TerminalPane, text: string) => boolean | Promise<boolean>;
  targetLabel: (pane: TerminalPane) => string;
  onStatus: (message: string, tone?: Tone) => void;
  tr: Translate;
};

export async function sendAIChatCodeToTerminal(button: HTMLElement, deps: AIChatCodeSendDeps) {
  const text = terminalTextFromCodeAction(button);
  if (!text) {
    deps.onStatus(deps.tr("status.aiNoOutput"), "error");
    return;
  }
  const pane = deps.activePane();
  if (!pane) {
    deps.onStatus(deps.tr("status.aiNoTerminalTarget"), "error");
    return;
  }
  const sent = await deps.sendText(pane, text);
  if (!sent) {
    deps.onStatus(deps.tr("status.aiNoTerminalTarget"), "error");
    return;
  }
  deps.onStatus(deps.tr("status.aiSentToTerminal", { target: deps.targetLabel(pane) }), "ok");
}

function terminalTextFromCodeAction(button: HTMLElement): string {
  const code = button.closest(".ai-code-block")?.querySelector<HTMLElement>("code")?.textContent ?? "";
  if (!code) return "";
  return code.endsWith("\n") ? code : `${code}\n`;
}
