export function mobileActionEventPhase(action: string): "pointerdown" | "pointerup" | "click" {
  if (action === "toggle-system-keyboard") return "pointerup";
  return action === "pane-menu" ? "click" : "pointerdown";
}

export function mobileActionRestoresKeyboard(action: string): boolean {
  return action !== "pane-menu" && action !== "toggle-system-keyboard";
}

export type MobileSyntheticActivation = {
  kind: "shortcut" | "chord" | "page" | "phrase" | "action";
  value: string;
};

export function mobileSyntheticActivation(
  button: Pick<HTMLButtonElement, "dataset">,
  clickDetail: number,
): MobileSyntheticActivation | undefined {
  if (clickDetail !== 0) return undefined;
  const candidates: MobileSyntheticActivation[] = [
    { kind: "shortcut", value: button.dataset.mobileShortcut ?? "" },
    { kind: "chord", value: button.dataset.mobileChord ?? "" },
    { kind: "page", value: button.dataset.mobilePage ?? "" },
    { kind: "phrase", value: button.dataset.mobilePhrase ?? "" },
    { kind: "action", value: button.dataset.mobileAction ?? "" },
  ];
  return candidates.find((candidate) => Boolean(candidate.value));
}
