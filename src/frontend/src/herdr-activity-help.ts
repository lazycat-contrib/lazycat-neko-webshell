import { herdrActivityGlyph } from "./herdr-activity.ts";

export function renderHerdrActivityHelp(): string {
  return `<button class="herdr-activity-info icon-button" type="button" data-herdr-activity-help-open aria-haspopup="dialog" aria-controls="herdrActivityHelp" aria-label="Status help" data-i18n-aria="herdr.activity.help"><i data-lucide="info" aria-hidden="true"></i></button>
    <dialog class="herdr-activity-help" id="herdrActivityHelp" aria-labelledby="herdrActivityHelpTitle">
      <div class="herdr-activity-help-content">
        <header><h3 id="herdrActivityHelpTitle" data-i18n="herdr.activity.help">Status colors</h3>
          <button class="icon-button" type="button" data-herdr-activity-help-close aria-label="Close" data-i18n-aria="action.close"><i data-lucide="x" aria-hidden="true"></i></button></header>
        <dl>${(["working", "blocked", "done", "idle", "unknown"] as const).map((status) => `<div data-status="${status}"><dt aria-hidden="true">${herdrActivityGlyph(status)}</dt><dd data-i18n="herdr.activity.${status}">${status}</dd></div>`).join("")}</dl>
      </div>
    </dialog>`;
}

export function bindHerdrActivityHelp(menu: HTMLElement) {
  const button = menu.querySelector<HTMLButtonElement>("[data-herdr-activity-help-open]");
  const dialog = menu.querySelector<HTMLDialogElement>(".herdr-activity-help");
  if (!button || !dialog) return;
  button.addEventListener("click", (event) => { event.stopPropagation(); if (!dialog.open) dialog.showModal(); });
  dialog.querySelector("[data-herdr-activity-help-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dialog.addEventListener("close", () => { if (!menu.hidden) button.focus({ preventScroll: true }); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
}
