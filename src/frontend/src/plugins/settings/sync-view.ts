import { renderPluginSettingsView, type PluginSettingsViewState } from "../../plugin-views";
import { bindTabListKeyboard } from "../../settings-tabs";
import { captureModalDraft, restoreModalDraft, settingsModalIdentity } from "./modal-draft";

const boundContainers = new WeakSet<HTMLElement>();
type FocusBookmark = { tag: string; attributes: readonly (readonly [string, string])[]; selection?: [number, number] };
const pendingFocus = new WeakMap<HTMLElement, FocusBookmark>();
const modalFocusReturn = new WeakMap<HTMLElement, FocusBookmark>();
const modalIdentities = new WeakMap<HTMLElement, string>();

export function syncPluginSettingsView(container: HTMLElement, state: PluginSettingsViewState) {
  if (!boundContainers.has(container)) {
    boundContainers.add(container);
    bindTabListKeyboard(container, '[role="tab"]');
    container.addEventListener("toggle", (event) => {
      if (!(event.target instanceof HTMLDetailsElement) || !event.target.hasAttribute("data-plugin-settings")) return;
      event.target.querySelector("summary")?.setAttribute("aria-expanded", String(event.target.open));
    }, true);
  }
  const expanded = new Set(Array.from(container.querySelectorAll<HTMLDetailsElement>("details[data-plugin-settings][open]"))
    .map((item) => item.dataset.pluginSettings ?? ""));
  const active = document.activeElement;
  const hadModal = Boolean(container.querySelector('[aria-modal="true"]'));
  const modalIdentity = settingsModalIdentity(state);
  const draft = hadModal && modalIdentities.get(container) === modalIdentity ? captureModalDraft(container) : [];
  const focusAttributes = active instanceof HTMLElement && container.contains(active)
    ? Array.from(active.attributes).filter((attribute) => attribute.name === "id" || attribute.name.startsWith("data-"))
      .map((attribute) => [attribute.name, attribute.value] as const)
    : [];
  if (active instanceof HTMLElement && focusAttributes.length) {
    const selection = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      && active.selectionStart !== null && active.selectionEnd !== null
      ? [active.selectionStart, active.selectionEnd] as [number, number] : undefined;
    pendingFocus.set(container, { tag: active.tagName, attributes: focusAttributes, selection });
  } else if (active !== document.body) {
    pendingFocus.delete(container);
  }
  container.innerHTML = renderPluginSettingsView(state, expanded);
  modalIdentities.set(container, modalIdentity);
  restoreModalDraft(container, draft);
  const hasModal = Boolean(container.querySelector('[aria-modal="true"]'));
  if (!hadModal && hasModal && pendingFocus.has(container)) {
    modalFocusReturn.set(container, pendingFocus.get(container)!);
  }
  if (!hadModal && hasModal) {
    const dialog = container.querySelector<HTMLElement>('[aria-modal="true"]');
    const first = dialog?.querySelector<HTMLElement>('input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)')
      ?? dialog?.querySelector<HTMLElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });
    return;
  }
  const bookmark = hadModal && !hasModal ? modalFocusReturn.get(container) : pendingFocus.get(container);
  if (hadModal && !hasModal) modalFocusReturn.delete(container);
  if (!bookmark || !container.getClientRects().length) return;
  const replacement = Array.from(container.querySelectorAll<HTMLElement>(bookmark.tag))
    .find((element) => bookmark.attributes.every(([name, value]) => element.getAttribute(name) === value));
  if (replacement && !("disabled" in replacement && replacement.disabled)) {
    replacement.focus({ preventScroll: true });
    if (bookmark.selection && (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement)) {
      replacement.setSelectionRange(...bookmark.selection);
    }
    pendingFocus.delete(container);
  }
}
