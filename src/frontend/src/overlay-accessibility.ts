const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]';

export function bindOverlayAccessibility(root: HTMLElement, settingsPage: HTMLElement) {
  function setModality(modality: "pointer" | "keyboard") {
    if (root.dataset.overlayInput !== modality) root.dataset.overlayInput = modality;
  }
  document.addEventListener("pointerdown", () => setModality("pointer"), true);
  document.addEventListener("keydown", (event) => {
    setModality("keyboard");
    if (settingsPage.hidden || !(event.target instanceof Element)) return;
    // A configuration dialog inside settings owns its own focus loop.
    const dialog = event.target.closest<HTMLElement>('[aria-modal="true"]');
    if (!dialog || !settingsPage.contains(dialog)) return;
    if (event.key === "Escape" && !dialog.classList.contains("settings-dialog")) {
      const dismiss = dialog.querySelector<HTMLButtonElement>("[data-overlay-dismiss]");
      if (dismiss) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss.click();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0 && !control.closest("[inert]"));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, true);
}
