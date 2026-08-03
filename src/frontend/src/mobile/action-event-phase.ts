export function mobileActionEventPhase(action: string): "pointerdown" | "click" {
  return action === "pane-menu" || action === "toggle-system-keyboard" ? "click" : "pointerdown";
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
