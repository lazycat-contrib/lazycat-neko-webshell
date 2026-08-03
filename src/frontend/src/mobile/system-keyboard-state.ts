export type SystemKeyboardToggle = {
  classList: Pick<DOMTokenList, "toggle">;
  setAttribute: (name: string, value: string) => void;
};

export function updateSystemKeyboardToggleState(
  button: SystemKeyboardToggle,
  enabled: boolean,
) {
  button.classList.toggle("active", enabled);
  button.setAttribute("aria-pressed", String(enabled));
}
