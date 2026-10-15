const directions = [
  { value: "up", label: "↑", name: "Up arrow" },
  { value: "down", label: "↓", name: "Down arrow" },
  { value: "left", label: "←", name: "Left arrow" },
  { value: "right", label: "→", name: "Right arrow" },
] as const;

export function renderMobileQuickBar(): string {
  return `
    ${directions.map((key) => `<button type="button" class="mobile-quick-key" data-mobile-shortcut="${key.value}" data-mobile-repeat="true" aria-label="${key.name}">${key.label}</button>`).join("")}
    <button type="button" class="mobile-quick-key" data-mobile-chord="ctrl-c" data-mobile-key-width="lg" aria-label="Ctrl+C">Ctrl+C</button>
    <button type="button" class="mobile-quick-key" data-mobile-action="paste-clipboard" data-mobile-key-width="lg" aria-label="Paste from clipboard">Ctrl+V</button>
    <button type="button" class="mobile-quick-key" data-mobile-chord="ctrl-z" data-mobile-key-width="lg" aria-label="Ctrl+Z">Ctrl+Z</button>
    <button type="button" class="mobile-quick-key" data-mobile-shortcut="ctrl" data-mobile-modifier="ctrl" aria-pressed="false">Ctrl</button>
    <button type="button" class="mobile-quick-key" data-mobile-shortcut="alt" data-mobile-modifier="alt" aria-pressed="false">Alt</button>
    <button type="button" class="mobile-quick-key" data-mobile-shortcut="shift" data-mobile-modifier="shift" aria-pressed="false">Shift</button>
  `;
}
