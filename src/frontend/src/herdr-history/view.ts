import "./view.css";
import type { MessageKey } from "../i18n.ts";
import type { HerdrSocketEnvelope, JsonRecord } from "../types.ts";
import { copyHerdrHistoryText } from "./clipboard.ts";
import { createHerdrHistoryController } from "./controller.ts";
import { escapeHtml } from "../utils.ts";
import type { HistoryState, HistoryTarget } from "./types.ts";
import { herdrHistoryTabTarget } from "./view-focus.ts";

const statusKeys: Record<HistoryState["status"], MessageKey> = {
  choose: "history.choose", loading: "history.loading", ready: "history.ready", searching: "history.searching",
  copying: "history.copying", copied: "history.copied", copyError: "history.copyError",
  empty: "history.empty", unsupported: "history.unsupported",
  stale: "history.stale", error: "history.error", targetChanged: "history.targetChanged", queryTooLong: "history.queryTooLong",
};

export function createHerdrHistoryDialog(options: {
  tr: (key: MessageKey, values?: Record<string, string | number>) => string;
  target: () => HistoryTarget | undefined;
  request: (method: string, params: JsonRecord, target: HistoryTarget) => Promise<HerdrSocketEnvelope>;
  prepare: () => void;
}) {
  let dialog: HTMLDialogElement | undefined;
  const controller = createHerdrHistoryController({
    ...options,
    copy: (text, isCurrent) => copyHerdrHistoryText(text, isCurrent, dialog),
    changed: render,
  });
  const text = (key: MessageKey) => escapeHtml(options.tr(key));

  function render(state: HistoryState) {
    if (!dialog) return;
    const select = dialog.querySelector<HTMLSelectElement>("select")!;
    const choices = [{ id: "", label: options.tr("history.choose") }, ...state.panes];
    if (select.options.length !== choices.length || choices.some((pane, index) => select.options[index]?.value !== pane.id)) {
      select.replaceChildren(...choices.map(pane => new Option(pane.label, pane.id)));
    }
    select.value = state.paneId;
    const busy = ["loading", "searching", "copying"].includes(state.status);
    const unavailable = state.status === "unsupported" || state.status === "targetChanged";
    select.disabled = state.status === "loading" || unavailable;
    dialog.querySelector<HTMLInputElement>("input")!.disabled = state.status === "loading" || unavailable;
    dialog.querySelector<HTMLElement>("[data-history-status]")!.textContent = options.tr(statusKeys[state.status]);
    dialog.querySelector<HTMLElement>("[data-history-count]")!.textContent = state.position
      ? options.tr("history.position", { current: state.position, total: state.total }) : "";
    dialog.querySelector<HTMLElement>("pre")!.textContent = state.preview;
    for (const button of dialog.querySelectorAll<HTMLButtonElement>("[data-history-search]")) {
      button.disabled = busy || unavailable || !state.paneId || !state.query.trim();
    }
    dialog.querySelector<HTMLButtonElement>("[data-history-copy]")!.disabled = busy || unavailable || !state.match;
  }

  function dismiss() {
    controller.dismiss();
    if (!dialog) return;
    const old = dialog; dialog = undefined;
    old.close(); old.remove();
  }

  async function open() {
    dismiss(); options.prepare();
    dialog = document.createElement("dialog");
    dialog.className = "herdr-console-dialog herdr-history-dialog";
    dialog.setAttribute("aria-labelledby", "herdr-history-title");
    dialog.innerHTML = `<header><span><h2 id="herdr-history-title">${text("history.title")}</h2><p>${text("history.hint")}</p></span>
      <button type="button" class="command-button" data-history-close>${text("action.close")}</button></header>
      <form class="herdr-console-form herdr-console-dialog-body">
        <label>${text("history.pane")}<select aria-label="${text("history.pane")}"></select></label>
        <label>${text("history.query")}<input type="search" maxlength="1024" autocomplete="off" placeholder="${text("history.query")}"></label>
        <div class="herdr-history-actions"><button class="command-button" type="submit" data-history-search="forward">${text("history.next")}</button>
          <button class="command-button" type="button" data-history-search="backward">${text("history.previous")}</button>
          <button class="command-button" type="button" data-history-search="refresh">${text("history.refresh")}</button>
          <button class="command-button" type="button" data-history-copy>${text("history.copy")}</button></div>
        <p data-history-status role="status" aria-live="polite"></p><p data-history-count></p>
        <pre aria-label="${text("history.match")}" tabindex="0"></pre>
      </form>`;
    document.body.append(dialog);
    dialog.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); dismiss(); }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]):not([hidden]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ));
      const target = herdrHistoryTabTarget(
        focusable,
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
        event.shiftKey,
      );
      if (!target) return;
      event.preventDefault();
      target.focus({ preventScroll: true });
    });
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.querySelector("[data-history-close]")!.addEventListener("click", dismiss);
    dialog.querySelector("select")!.addEventListener("change", event => controller.selectPane((event.target as HTMLSelectElement).value));
    dialog.querySelector("input")!.addEventListener("input", event => controller.setQuery((event.target as HTMLInputElement).value));
    dialog.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); void controller.search("forward"); });
    dialog.querySelector('[data-history-search="backward"]')!.addEventListener("click", () => void controller.search("backward"));
    dialog.querySelector('[data-history-search="refresh"]')!.addEventListener("click", () => void controller.search("forward", true));
    dialog.querySelector("[data-history-copy]")!.addEventListener("click", () => void controller.copy());
    dialog.showModal();
    await controller.open();
  }
  return { open, dismiss };
}
