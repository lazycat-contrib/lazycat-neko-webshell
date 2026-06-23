import type { SplitPlacement } from "./types";

const ZELLIJ_SPLIT_KEYS: Partial<Record<SplitPlacement, string>> = {
  right: "r",
  down: "d",
};

const ZELLIJ_PANE_MODE_PREFIX = "\x10";

export function zellijSplitKey(placement: SplitPlacement): string | undefined {
  return ZELLIJ_SPLIT_KEYS[placement];
}

export function zellijPaneModeInput(key: string): string {
  return `${ZELLIJ_PANE_MODE_PREFIX}${key}`;
}
