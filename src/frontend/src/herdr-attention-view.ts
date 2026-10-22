import type { MessageKey } from "./i18n.ts";
import type { HerdrJumpModel, HerdrJumpTarget } from "./herdr-jump-model.ts";
import { escapeHtml } from "./utils.ts";

type Translate = (key: MessageKey) => string;

export function attentionTarget(model: HerdrJumpModel, id: string): HerdrJumpTarget | undefined {
  return model.groups.flatMap(group => group.targets)
    .find(target => target.status === "blocked" && target.attention?.id === id);
}

export function renderHerdrAttentionDetail(target: HerdrJumpTarget, tr: Translate): string {
  return `<div class="herdr-attention-content">
    <header><h3 id="herdr-attention-title">${escapeHtml(tr("herdr.attention.title"))}</h3>
      <button class="icon-button" type="button" data-attention-close aria-label="${escapeHtml(tr("action.close"))}">×</button></header>
    <strong>${escapeHtml(target.label)}</strong>
    <p>${escapeHtml(target.attention?.summary || tr("herdr.attention.fallback"))}</p>
    <button class="herdr-attention-jump" type="button" data-attention-jump>${escapeHtml(tr("herdr.attention.jump"))}</button>
  </div>`;
}

/** A detail surface for existing jump targets. No requests or terminal content reads. */
export function createHerdrAttentionView(options: {
  menu: HTMLElement;
  tr: Translate;
  navigate: (target: HerdrJumpTarget) => void;
}) {
  let model: HerdrJumpModel = { groups: [] };
  let context: string | undefined;
  let openId: string | undefined;
  let rendered = "";
  let dialog: HTMLDialogElement | undefined;

  function restoreFocus(id: string | undefined) {
    const trigger = [...options.menu.querySelectorAll<HTMLButtonElement>("[data-herdr-attention]")]
      .find(button => button.dataset.herdrAttention === id);
    (trigger ?? options.menu.querySelector<HTMLButtonElement>("[data-herdr-activity-help-open]"))?.focus({ preventScroll: true });
  }

  function close(restore = true) {
    if (!dialog?.open) return;
    const id = openId;
    openId = undefined;
    dialog.close();
    if (restore) restoreFocus(id);
  }

  function renderDetail(target: HerdrJumpTarget) {
    if (!dialog) return;
    const html = renderHerdrAttentionDetail(target, options.tr);
    if (rendered === html) return;
    const jumpFocused = dialog.querySelector("[data-attention-jump]") === document.activeElement;
    dialog.innerHTML = html;
    rendered = html;
    if (dialog.open) dialog.querySelector<HTMLButtonElement>(jumpFocused ? "[data-attention-jump]" : "[data-attention-close]")?.focus({ preventScroll: true });
  }

  function handleMenuClick(event: MouseEvent) {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-attention]") : null;
    if (!button) return;
    event.stopPropagation();
    const target = attentionTarget(model, button.dataset.herdrAttention ?? "");
    if (!target) return;
    openId = target.attention!.id;
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "herdr-attention-dialog";
      dialog.setAttribute("aria-labelledby", "herdr-attention-title");
      dialog.addEventListener("click", handleDetailClick);
      dialog.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const buttons = [...dialog!.querySelectorAll<HTMLButtonElement>("button")];
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      });
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      options.menu.append(dialog);
    }
    renderDetail(target);
    if (!dialog.open) dialog.showModal();
  }

  function handleDetailClick(event: MouseEvent) {
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    if (target === dialog || target?.closest("[data-attention-close]")) return close();
    if (!target?.closest("[data-attention-jump]")) return;
    const current = attentionTarget(model, openId ?? "");
    close(false);
    if (current) options.navigate(current);
  }
  options.menu.addEventListener("click", handleMenuClick);

  return {
    sync(next: HerdrJumpModel, nextContext: string | undefined) {
      model = next;
      if (context !== nextContext) close(false);
      context = nextContext;
      if (!dialog?.open) return;
      const target = attentionTarget(model, openId ?? "");
      if (target) renderDetail(target);
      else close();
    },
    close: () => close(false),
    destroy() {
      close(false);
      options.menu.removeEventListener("click", handleMenuClick);
      dialog?.remove();
    },
  };
}
