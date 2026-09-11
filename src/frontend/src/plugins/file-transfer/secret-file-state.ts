import type { TerminalPane } from "../../types";

export const MAX_SECRET_BYTES = 1024 * 1024;
export type SecretFileShortcut = "alt-v" | "alt-k" | "disabled";
export type SecretFileTarget = {
  pane: TerminalPane;
  sessionId: string;
  selector: string;
  generation: number;
};
export type SecretFileResult = { path: string; target: SecretFileTarget };

export function secretFilePathIsValid(path: unknown): path is string {
  return typeof path === "string" && /^\/tmp\/lazycat-webshell-secret-[0-9a-f]{32}\/key-[0-9a-f]{32}$/.test(path);
}

export function secretFilePayload(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!text || text.length > MAX_SECRET_BYTES) return undefined;
  const payload = new TextEncoder().encode(text);
  return payload.length <= MAX_SECRET_BYTES ? payload : undefined;
}

export function secretFileTargetIsCurrent(target: SecretFileTarget, pane: TerminalPane | undefined, generation: number): boolean {
  return target.pane === pane && target.generation === generation
    && pane.sessionId === target.sessionId && pane.selector === target.selector
    && !pane.closing && !pane.exited;
}

export function secretFileShortcutMatches(
  event: Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing">,
  shortcut: SecretFileShortcut,
  apple: boolean,
): boolean {
  if (shortcut === "disabled" || event.repeat || event.isComposing || event.shiftKey) return false;
  return event.altKey && (apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
    && event.code === (shortcut === "alt-k" ? "KeyK" : "KeyV");
}

export function secretFileShortcutLabel(shortcut: SecretFileShortcut, apple: boolean): string {
  if (shortcut === "disabled") return "—";
  return `${apple ? "⌘⌥" : "Ctrl+Alt+"}${shortcut === "alt-k" ? "K" : "V"}`;
}
