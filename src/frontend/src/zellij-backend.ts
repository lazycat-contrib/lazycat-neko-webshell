import { keyEventToTerminalSequence } from "./keyboard";
import type { SplitPlacement } from "./types";

const ZELLIJ_SPLIT_KEYS: Partial<Record<SplitPlacement, string>> = {
  right: "r",
  down: "d",
};

const ZELLIJ_PANE_MODE_PREFIX = "\x10";
const ZELLIJ_CLOSE_PANE_KEY = "x";
const ZELLIJ_FOCUS_SHORTCUT_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function zellijSplitKey(placement: SplitPlacement): string | undefined {
  return ZELLIJ_SPLIT_KEYS[placement];
}

export function zellijPaneModeInput(key: string): string {
  return `${ZELLIJ_PANE_MODE_PREFIX}${key}`;
}

export function zellijSplitPaneInput(placement: SplitPlacement): string | undefined {
  const key = zellijSplitKey(placement);
  return key ? zellijPaneModeInput(key) : undefined;
}

export function zellijClosePaneInput(): string {
  return zellijPaneModeInput(ZELLIJ_CLOSE_PANE_KEY);
}

export function zellijTerminalShortcutInput(event: KeyboardEvent): string | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) {
    return undefined;
  }
  if (!ZELLIJ_FOCUS_SHORTCUT_KEYS.has(event.key)) {
    return undefined;
  }
  return keyEventToTerminalSequence(event);
}
